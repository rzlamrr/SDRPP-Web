#include <imgui.h>
#include <utils/flog.h>
#include <module.h>
#include <gui/gui.h>
#include <signal_path/signal_path.h>
#include <core.h>
#include <gui/style.h>
#include <config.h>
#include <gui/widgets/stepped_slider.h>
#include <libbladeRF.h>
#include <gui/smgui.h>
#include <algorithm>
#include <chrono>
#include <map>
#include <string.h>
#include <utils/optionlist.h>

#define CONCAT(a, b) ((std::string(a) + b).c_str())

#define NUM_BUFFERS   128
#define NUM_TRANSFERS 1

// Quick retune (band hopping): number of profiles kept per device and how long they stay valid.
// libbladeRF notes that the stored tuning parameters drift with temperature.
#define MAX_QUICK_TUNES        8
#define QUICK_TUNE_LIFETIME_S  300

SDRPP_MOD_INFO{
    /* Name:            */ "bladerf_source",
    /* Description:     */ "BladeRF source module for SDR++",
    /* Author:          */ "Ryzerth",
    /* Version:         */ 0, 1, 0,
    /* Max instances    */ 8
};

ConfigManager config;

// Name of the instance SDR++ creates by default. It keeps the original source name and
// config key, additional instances (web monitor, one per radio) get their own.
#define DEFAULT_INSTANCE_NAME "BladeRF Source"

enum BladeRFType {
    BLADERF_TYPE_UNKNOWN,
    BLADERF_TYPE_V1,
    BLADERF_TYPE_V2
};

class BladeRFSourceModule : public ModuleManager::Instance {
public:
    BladeRFSourceModule(std::string name) {
        this->name = name;

        // Define clocks
        clocks.define("onboard", "On-Board", CLOCK_SELECT_ONBOARD);
        clocks.define("external", "External", CLOCK_SELECT_EXTERNAL);

        sampleRate = 1000000.0;

        handler.ctx = this;
        handler.selectHandler = menuSelected;
        handler.deselectHandler = menuDeselected;
        handler.menuHandler = menuHandler;
        handler.startHandler = start;
        handler.stopHandler = stop;
        handler.tuneHandler = tune;
        handler.stream = &stream;

        refresh();

        // Select device here
        std::string serial = loadSavedDevice();
        if (serial.empty() && !isDefaultInstance() && instanceIndex() < devCount) {
            // First run of an additional instance: take the next device instead of the first one
            serial = devInfoList[instanceIndex()].serial;
        }
        selectBySerial(serial);

        sourceName = isDefaultInstance() ? "BladeRF" : name;
        sigpath::sourceManager.registerSource(sourceName, &handler);
    }

    ~BladeRFSourceModule() {
        stop(this);
        sigpath::sourceManager.unregisterSource(sourceName);
    }

    bool isDefaultInstance() {
        return name == DEFAULT_INSTANCE_NAME;
    }

    // Zero based index taken from a "... #N" instance name, 0 if there is none
    int instanceIndex() {
        size_t pos = name.rfind('#');
        if (pos == std::string::npos) { return 0; }
        int n = atoi(name.c_str() + pos + 1);
        return (n > 0) ? (n - 1) : 0;
    }

    std::string loadSavedDevice() {
        std::string serial = "";
        config.acquire();
        if (isDefaultInstance()) {
            if (config.conf["device"].is_string()) { serial = config.conf["device"]; }
        }
        else if (config.conf.contains("instances") && config.conf["instances"].contains(name) &&
                 config.conf["instances"][name]["device"].is_string()) {
            serial = config.conf["instances"][name]["device"];
        }
        config.release();
        return serial;
    }

    void saveDevice() {
        config.acquire();
        if (isDefaultInstance()) { config.conf["device"] = selectedSerial; }
        else { config.conf["instances"][name]["device"] = selectedSerial; }
        config.release(true);
    }

    void postInit() {}

    void enable() {
        enabled = true;
    }

    void disable() {
        enabled = false;
    }

    bool isEnabled() {
        return enabled;
    }

    void refresh() {
        devListTxt = "";

        if (devInfoList != NULL) {
            bladerf_free_device_list(devInfoList);
        }

        devCount = bladerf_get_device_list(&devInfoList);
        if (devCount < 0) {
            flog::error("Could not list devices {0}", devCount);
            return;
        }
        for (int i = 0; i < devCount; i++) {
            // Keep only the first 32 character of the serial number for display
            devListTxt += std::string(devInfoList[i].serial).substr(0, 16);
            devListTxt += '\0';
        }
    }

    void selectFirst() {
        if (devCount > 0) { selectByInfo(&devInfoList[0]); }
        else {
            selectedSerial = "";
        }
    }

    void selectBySerial(std::string serial, bool reloadChannelId = true) {
        if (serial == "") {
            selectFirst();
            return;
        }
        for (int i = 0; i < devCount; i++) {
            bladerf_devinfo info = devInfoList[i];
            if (serial == info.serial) {
                devId = i;
                selectByInfo(&info, reloadChannelId);
                return;
            }
        }
        selectFirst();
    }

    // Opens a device by serial number alone. The instance number and USB address in a stored
    // devinfo change as soon as another bladeRF is opened by this program, so they must not be matched.
    int openBySerial(const char* serial) {
        bladerf_devinfo any;
        bladerf_init_devinfo(&any);
        strncpy(any.serial, serial, sizeof(any.serial) - 1);
        any.serial[sizeof(any.serial) - 1] = 0;
        return bladerf_open_with_devinfo(&openDev, &any);
    }

    void selectByInfo(bladerf_devinfo* info, bool reloadChannelId = true) {
        int ret = openBySerial(info->serial);
        if (ret != 0) {
            flog::error("Could not open device {0}", info->serial);
            selectedSerial = "";
            return;
        }

        selectedSerial = info->serial;
        for (int i = 0; i < devCount; i++) {
            if (selectedSerial == devInfoList[i].serial) { devId = i; }
        }

        // Get the board type
        const char* bname = bladerf_get_board_name(openDev);
        if (!strcmp(bname, "bladerf1")) {
            selectedBladeType = BLADERF_TYPE_V1;
        }
        else if (!strcmp(bname, "bladerf2")) {
            selectedBladeType = BLADERF_TYPE_V2;
        }
        else {
            selectedBladeType = BLADERF_TYPE_UNKNOWN;
        }

        // Gather info about the BladeRF's ranges
        channelCount = bladerf_get_channel_count(openDev, BLADERF_RX);

        // Load the channelId if there are more than 1 channel
        if (reloadChannelId) {
            config.acquire();
            if (channelCount > 1 && config.conf["devices"].contains(info->serial)) {
                if (config.conf["devices"][info->serial].contains("channelId")) {
                    chanId = config.conf["devices"][info->serial]["channelId"];
                }
                else {
                    chanId = 0;
                }
            }
            else {
                chanId = 0;
            }
            config.release();
        }

        chanId = std::clamp<int>(chanId, 0, channelCount - 1);

        bladerf_get_sample_rate_range(openDev, BLADERF_CHANNEL_RX(chanId), &srRange);
        bladerf_get_bandwidth_range(openDev, BLADERF_CHANNEL_RX(chanId), &bwRange);
        bladerf_get_gain_range(openDev, BLADERF_CHANNEL_RX(chanId), &gainRange);
        int gainModeCount = bladerf_get_gain_modes(openDev, BLADERF_CHANNEL_RX(chanId), &gainModes);

        // Generate sampleRate and Bandwidth lists
        sampleRates.clear();
        sampleRatesTxt = "";
        sampleRates.push_back(srRange->min);
        sampleRatesTxt += getBandwdithScaled(srRange->min);
        sampleRatesTxt += '\0';
        for (int i = 2000000; i < srRange->max; i += 2000000) {
            sampleRates.push_back(i);
            sampleRatesTxt += getBandwdithScaled(i);
            sampleRatesTxt += '\0';
        }
        sampleRates.push_back(srRange->max);
        sampleRatesTxt += getBandwdithScaled(srRange->max);
        sampleRatesTxt += '\0';

        // Generate bandwidth list
        bandwidths.clear();
        bandwidthsTxt = "";
        bandwidths.push_back(bwRange->min);
        bandwidthsTxt += getBandwdithScaled(bwRange->min);
        bandwidthsTxt += '\0';
        for (int i = 2000000; i < bwRange->max; i += 2000000) {
            bandwidths.push_back(i);
            bandwidthsTxt += getBandwdithScaled(i);
            bandwidthsTxt += '\0';
        }
        bandwidths.push_back(bwRange->max);
        bandwidthsTxt += getBandwdithScaled(bwRange->max);
        bandwidthsTxt += '\0';
        bandwidthsTxt += "Auto";
        bandwidthsTxt += '\0';

        // Generate list of channel names
        channelNamesTxt = "";
        char buf[32];
        for (int i = 0; i < channelCount; i++) {
            sprintf(buf, "RX %d", i + 1);
            channelNamesTxt += buf;
            channelNamesTxt += '\0';
        }

        // Generate gain mode list
        gainModeNames.clear();
        gainModesTxt = "";
        for (int i = 0; i < gainModeCount; i++) {
            std::string gm = gainModes[i].name;
            gm[0] = gm[0] & (~0x20);
            gainModeNames.push_back(gm);
            gainModesTxt += gm;
            gainModesTxt += '\0';
        }

        // Load settings here
        config.acquire();

        if (!config.conf["devices"].contains(selectedSerial)) {
            config.conf["devices"][info->serial]["channelId"] = 0;
            config.conf["devices"][selectedSerial]["sampleRate"] = sampleRates[0];
            config.conf["devices"][selectedSerial]["bandwidth"] = bandwidths.size(); // Auto
            config.conf["devices"][selectedSerial]["gainMode"] = "Manual";
            config.conf["devices"][selectedSerial]["overallGain"] = gainRange->min;
        }

        // Load sample rate
        if (config.conf["devices"][selectedSerial].contains("sampleRate")) {
            bool found = false;
            uint64_t sr = config.conf["devices"][selectedSerial]["sampleRate"];
            for (int i = 0; i < sampleRates.size(); i++) {
                if (sr == sampleRates[i]) {
                    srId = i;
                    sampleRate = sampleRates[i];
                    found = true;
                    break;
                }
            }
            if (!found) {
                srId = 0;
                sampleRate = sampleRates[0];
            }
        }
        else {
            srId = 0;
            sampleRate = sampleRates[0];
        }

        // Load bandwidth
        if (config.conf["devices"][selectedSerial].contains("bandwidth")) {
            bwId = config.conf["devices"][selectedSerial]["bandwidth"];
            bwId = std::clamp<int>(bwId, 0, bandwidths.size());
        }
        else {
            bwId = 0;
        }
        config.release(true);

        // Load clock source
        clkId = clocks.keyId("onboard");
        if (config.conf["devices"][selectedSerial].contains("clock")) {
            std::string clkStr = config.conf["devices"][selectedSerial]["clock"];
            if (clocks.keyExists(clkStr)) {
                clkId = clocks.keyId(clkStr);
            }
        }

        // Load gain mode
        if (config.conf["devices"][selectedSerial].contains("gainMode")) {
            std::string gm = config.conf["devices"][selectedSerial]["gainMode"];
            bool found = false;
            for (int i = 0; i < gainModeNames.size(); i++) {
                if (gainModeNames[i] == gm) {
                    gainMode = i;
                    found = true;
                    break;
                }
            }
            if (!found) {
                for (int i = 0; i < gainModeNames.size(); i++) {
                    if (gainModeNames[i] == "Manual") {
                        gainMode = i;
                        break;
                    }
                }
            }
        }
        else {
            for (int i = 0; i < gainModeNames.size(); i++) {
                if (gainModeNames[i] == "Manual") {
                    gainMode = i;
                    break;
                }
            }
        }

        // Load gain
        if (config.conf["devices"][selectedSerial].contains("overallGain")) {
            overallGain = config.conf["devices"][selectedSerial]["overallGain"];
            overallGain = std::clamp<int>(overallGain, gainRange->min, gainRange->max);
        }
        else {
            overallGain = gainRange->min;
        }

        // Load Bias-T
        if (selectedBladeType == BLADERF_TYPE_V2) {
            if (config.conf["devices"][selectedSerial].contains("biasT")) {
                biasT = config.conf["devices"][selectedSerial]["biasT"];
            }
            else {
                biasT = false;
            }
        }

        bladerf_close(openDev);
    }

private:
    std::string getBandwdithScaled(double bw) {
        char buf[1024];
        if (bw >= 1000000.0) {
            sprintf(buf, "%.1lfMHz", bw / 1000000.0);
        }
        else if (bw >= 1000.0) {
            sprintf(buf, "%.1lfKHz", bw / 1000.0);
        }
        else {
            sprintf(buf, "%.1lfHz", bw);
        }
        return std::string(buf);
    }

    static void menuSelected(void* ctx) {
        BladeRFSourceModule* _this = (BladeRFSourceModule*)ctx;
        core::setInputSampleRate(_this->sampleRate);
        flog::info("BladeRFSourceModule '{0}': Menu Select!", _this->name);
    }

    static void menuDeselected(void* ctx) {
        BladeRFSourceModule* _this = (BladeRFSourceModule*)ctx;
        flog::info("BladeRFSourceModule '{0}': Menu Deselect!", _this->name);
    }

    static void start(void* ctx) {
        BladeRFSourceModule* _this = (BladeRFSourceModule*)ctx;
        if (_this->running) { return; }
        if (_this->devCount <= 0) { return; }

        // Open device
        bladerf_devinfo info = _this->devInfoList[_this->devId];
        int ret = _this->openBySerial(info.serial);
        if (ret != 0) {
            flog::error("Could not open device {0}", info.serial);
            return;
        }

        // Quick retune profiles belong to the device session
        _this->quickTunes.clear();
        _this->tuneCounts.clear();
        _this->quickTuneBroken = false;
        _this->quickTunesBorn = std::chrono::steady_clock::now();

        // Calculate buffer size, must be a multiple of 1024
        _this->bufferSize = _this->sampleRate / 200.0;
        _this->bufferSize /= 1024;
        _this->bufferSize *= 1024;
        if (_this->bufferSize < 1024) { _this->bufferSize = 1024; }

        // Setup device parameters
        _this->setClockSource(_this->clocks[_this->clkId]);
        bladerf_set_sample_rate(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), _this->sampleRate, NULL);
        bladerf_set_frequency(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), _this->freq);
        bladerf_set_bandwidth(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), (_this->bwId == _this->bandwidths.size()) ? std::clamp<uint64_t>(_this->sampleRate, _this->bwRange->min, _this->bwRange->max) : _this->bandwidths[_this->bwId], NULL);
        bladerf_set_gain_mode(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), _this->gainModes[_this->gainMode].mode);

        if (_this->selectedBladeType == BLADERF_TYPE_V2) {
            bladerf_set_bias_tee(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), _this->biasT);
        }

        // If gain mode is manual, set the gain
        if (_this->gainModes[_this->gainMode].mode == BLADERF_GAIN_MANUAL) {
            bladerf_set_gain(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), _this->overallGain);
        }

        _this->streamingEnabled = true;

        // Setup synchronous transfer
        bladerf_sync_config(_this->openDev, BLADERF_RX_X1, BLADERF_FORMAT_SC16_Q11, 16, _this->bufferSize, 8, 3500);

        // Enable streaming
        bladerf_enable_module(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), true);

        _this->running = true;
        _this->workerThread = std::thread(&BladeRFSourceModule::worker, _this);

        flog::info("BladeRFSourceModule '{0}': Start!", _this->name);
    }

    static void stop(void* ctx) {
        BladeRFSourceModule* _this = (BladeRFSourceModule*)ctx;
        if (!_this->running) { return; }
        _this->running = false;
        _this->stream.stopWriter();

        _this->streamingEnabled = false;
        // Wait for read worker to terminate
        if (_this->workerThread.joinable()) {
            _this->workerThread.join();
        }

        // Disable streaming
        bladerf_enable_module(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), false);

        // Close device
        bladerf_close(_this->openDev);

        _this->stream.clearWriteStop();
        flog::info("BladeRFSourceModule '{0}': Stop!", _this->name);
    }

    static void tune(double freq, void* ctx) {
        BladeRFSourceModule* _this = (BladeRFSourceModule*)ctx;
        _this->freq = freq;
        if (_this->running) {
            _this->retune();
        }
    }

    // Tunes to freq. A frequency that keeps coming back (a monitor visiting several bands in turn)
    // gets a quick retune profile, which skips the slow tuning algorithm from then on.
    void retune() {
        bladerf_channel ch = BLADERF_CHANNEL_RX(chanId);
        uint64_t f = (uint64_t)freq;

        auto now = std::chrono::steady_clock::now();
        if (now - quickTunesBorn > std::chrono::seconds(QUICK_TUNE_LIFETIME_S)) {
            quickTunes.clear();
            quickTunesBorn = now;
        }

        auto qt = quickTunes.find(f);
        if (qt != quickTunes.end()) {
            if (bladerf_schedule_retune(openDev, ch, BLADERF_RETUNE_NOW, 0, &qt->second) == 0) {
                quickRetunes++;
                return;
            }
            flog::warn("BladeRFSourceModule '{0}': quick retune failed, using normal tuning", name);
            quickTunes.clear();
            quickTuneBroken = true;
        }

        bladerf_set_frequency(openDev, ch, f);

        // Manual tuning produces many frequencies that are used once, those get no profile
        if (tuneCounts.size() > 256) { tuneCounts.clear(); }
        int count = ++tuneCounts[f];
        if (count >= 2 && !quickTuneBroken && quickTunes.size() < MAX_QUICK_TUNES) {
            bladerf_quick_tune profile;
            if (bladerf_get_quick_tune(openDev, ch, &profile) == 0) {
                quickTunes[f] = profile;
                flog::info("BladeRFSourceModule '{0}': quick retune profile stored for {1} Hz", name, freq);
            }
        }
    }

    static void menuHandler(void* ctx) {
        BladeRFSourceModule* _this = (BladeRFSourceModule*)ctx;

        if (_this->running) { SmGui::BeginDisabled(); }

        SmGui::FillWidth();
        SmGui::ForceSync();
        if (SmGui::Combo(CONCAT("##_balderf_dev_sel_", _this->name), &_this->devId, _this->devListTxt.c_str())) {
            bladerf_devinfo info = _this->devInfoList[_this->devId];
            _this->selectByInfo(&info);
            core::setInputSampleRate(_this->sampleRate);
            _this->saveDevice();
        }

        if (SmGui::Combo(CONCAT("##_balderf_sr_sel_", _this->name), &_this->srId, _this->sampleRatesTxt.c_str())) {
            _this->sampleRate = _this->sampleRates[_this->srId];
            core::setInputSampleRate(_this->sampleRate);
            if (_this->selectedSerial != "") {
                config.acquire();
                config.conf["devices"][_this->selectedSerial]["sampleRate"] = _this->sampleRates[_this->srId];
                config.release(true);
            }
        }

        // Refresh button
        SmGui::SameLine();
        SmGui::FillWidth();
        SmGui::ForceSync();
        if (SmGui::Button(CONCAT("Refresh##_balderf_refr_", _this->name))) {
            _this->refresh();
            _this->selectBySerial(_this->selectedSerial, false);
            core::setInputSampleRate(_this->sampleRate);
        }

        // Channel selection (only show if more than one channel)
        if (_this->channelCount > 1) {
            SmGui::LeftLabel("RX Channel");
            SmGui::FillWidth();
            SmGui::Combo(CONCAT("##_balderf_ch_sel_", _this->name), &_this->chanId, _this->channelNamesTxt.c_str());
            if (_this->selectedSerial != "") {
                config.acquire();
                config.conf["devices"][_this->selectedSerial]["channelId"] = _this->chanId;
                config.release(true);
            }
        }

        if (_this->running) { SmGui::EndDisabled(); }

        SmGui::LeftLabel("Bandwidth");
        SmGui::FillWidth();
        if (SmGui::Combo(CONCAT("##_balderf_bw_sel_", _this->name), &_this->bwId, _this->bandwidthsTxt.c_str())) {
            if (_this->running) {
                bladerf_set_bandwidth(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), (_this->bwId == _this->bandwidths.size()) ? std::clamp<uint64_t>(_this->sampleRate, _this->bwRange->min, _this->bwRange->max) : _this->bandwidths[_this->bwId], NULL);
            }
            if (_this->selectedSerial != "") {
                config.acquire();
                config.conf["devices"][_this->selectedSerial]["bandwidth"] = _this->bwId;
                config.release(true);
            }
        }

        SmGui::LeftLabel("Clock Source");
        SmGui::FillWidth();
        if (SmGui::Combo(CONCAT("##_balderf_clk_sel_", _this->name), &_this->clkId, _this->clocks.txt)) {
            if (_this->running) {
                _this->setClockSource(_this->clocks[_this->clkId]);
            }
            if (_this->selectedSerial != "") {
                config.acquire();
                config.conf["devices"][_this->selectedSerial]["clock"] = _this->clocks.key(_this->clkId);
                config.release(true);
            }
        }

        // General config BS
        SmGui::LeftLabel("Gain control mode");
        SmGui::FillWidth();
        SmGui::ForceSync();
        if (SmGui::Combo(CONCAT("##_balderf_gm_sel_", _this->name), &_this->gainMode, _this->gainModesTxt.c_str()) && _this->selectedSerial != "") {
            if (_this->running) {
                bladerf_set_gain_mode(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), _this->gainModes[_this->gainMode].mode);
            }
            // if switched to manual, reset gains
            if (_this->gainModes[_this->gainMode].mode == BLADERF_GAIN_MANUAL && _this->running) {
                bladerf_set_gain(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), _this->overallGain);
            }
            if (_this->selectedSerial != "") {
                config.acquire();
                config.conf["devices"][_this->selectedSerial]["gainMode"] = _this->gainModeNames[_this->gainMode];
                config.release(true);
            }
        }

        if (_this->selectedSerial != "") {
            if (_this->gainModes[_this->gainMode].mode != BLADERF_GAIN_MANUAL) { SmGui::BeginDisabled(); }
        }
        SmGui::LeftLabel("Gain");
        SmGui::FillWidth();
        if (SmGui::SliderInt("##_balderf_oag_sel_", &_this->overallGain, (_this->gainRange != NULL) ? _this->gainRange->min : 0, (_this->gainRange != NULL) ? _this->gainRange->max : 60)) {
            if (_this->running) {
                flog::info("Setting gain to {0}", _this->overallGain);
                bladerf_set_gain(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), _this->overallGain);
            }
            if (_this->selectedSerial != "") {
                config.acquire();
                config.conf["devices"][_this->selectedSerial]["overallGain"] = _this->overallGain;
                config.release(true);
            }
        }
        if (_this->selectedSerial != "") {
            if (_this->gainModes[_this->gainMode].mode != BLADERF_GAIN_MANUAL) { SmGui::EndDisabled(); }
        }

        if (_this->selectedBladeType == BLADERF_TYPE_V2) {
            if (SmGui::Checkbox("Bias-T##_balderf_biast_", &_this->biasT)) {
                if (_this->running) {
                    bladerf_set_bias_tee(_this->openDev, BLADERF_CHANNEL_RX(_this->chanId), _this->biasT);
                }
                config.acquire();
                config.conf["devices"][_this->selectedSerial]["biasT"] = _this->biasT;
                config.release(true);
            }
        }
    }

    void setClockSource(bladerf_clock_select clk) {
        if (selectedBladeType == BLADERF_TYPE_V1) {
            bladerf_set_smb_mode(openDev, (clk == CLOCK_SELECT_EXTERNAL) ? BLADERF_SMB_MODE_INPUT : BLADERF_SMB_MODE_DISABLED);
        }
        else {
            bladerf_set_clock_select(openDev, clk);
        }
    }

    void worker() {
        int16_t* buffer = new int16_t[bufferSize * 2];
        bladerf_metadata meta;

        while (streamingEnabled) {
            // Receive from the stream and break on error
            int ret = bladerf_sync_rx(openDev, buffer, bufferSize, &meta, 3500);
            if (ret != 0) { break; }

            // Convert to complex float and swap buffers
            volk_16i_s32f_convert_32f((float*)stream.writeBuf, buffer, 32768.0f, bufferSize * 2);
            if (!stream.swap(bufferSize)) { break; }
        }

        delete[] buffer;
    }

    std::string name;
    std::string sourceName;
    bladerf* openDev;
    bool enabled = true;
    dsp::stream<dsp::complex_t> stream;
    double sampleRate;
    SourceManager::SourceHandler handler;
    bool running = false;
    double freq;
    int devId = 0;
    int srId = 0;
    int bwId = 0;
    int clkId = 0;
    int chanId = 0;
    int gainMode = 0;
    bool streamingEnabled = false;
    bool biasT = false;

    int channelCount;

    const bladerf_range* srRange = NULL;
    const bladerf_range* bwRange = NULL;
    const bladerf_range* gainRange = NULL;

    std::vector<uint64_t> sampleRates;
    std::string sampleRatesTxt;
    std::vector<uint64_t> bandwidths;
    std::string bandwidthsTxt;
    std::string channelNamesTxt;
    OptionList<std::string, bladerf_clock_select> clocks;

    int bufferSize;
    struct bladerf_stream* rxStream;

    int overallGain = 0;

    std::thread workerThread;

    int devCount = 0;
    bladerf_devinfo* devInfoList = NULL;
    std::string devListTxt;

    std::string selectedSerial;

    std::map<uint64_t, bladerf_quick_tune> quickTunes;
    std::map<uint64_t, int> tuneCounts;
    std::chrono::steady_clock::time_point quickTunesBorn;
    bool quickTuneBroken = false;
    uint64_t quickRetunes = 0;

    BladeRFType selectedBladeType = BLADERF_TYPE_UNKNOWN;

    const bladerf_gain_modes* gainModes;
    std::vector<std::string> gainModeNames;
    std::string gainModesTxt;
    int gainModeCount;
};

MOD_EXPORT void _INIT_() {
    json def = json({});
    def["devices"] = json({});
    def["device"] = "";
    config.setPath(core::args["root"].s() + "/bladerf_config.json");
    config.load(def);
    config.enableAutoSave();
}

MOD_EXPORT ModuleManager::Instance* _CREATE_INSTANCE_(std::string name) {
    return new BladeRFSourceModule(name);
}

MOD_EXPORT void _DELETE_INSTANCE_(ModuleManager::Instance* instance) {
    delete (BladeRFSourceModule*)instance;
}

MOD_EXPORT void _END_() {
    config.disableAutoSave();
    config.save();
}
