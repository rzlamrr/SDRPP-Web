#include "engine.h"
#include "radio.h"
#include <core.h>
#include <config.h>
#include <gui/smgui.h>
#include <utils/flog.h>
#include <algorithm>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <set>
#include <thread>
#include <fstream>
#include <memory>
#include <vector>
#include <mutex>
#include <stdexcept>
#include <ctime>
#include <map>

using nlohmann::json;

namespace web {
    namespace engine {
        namespace {
            struct SourceType {
                std::string id;
                std::string name;         // Name the default instance registers in the source manager
                std::string module;
                std::string instanceName; // Name of the instance desktop SDR++ creates
                int settleMs;             // Time the tuner needs after a retune
            };

            const std::vector<SourceType> sourceTypes = {
                { "bladerf", "BladeRF", "bladerf_source", "BladeRF Source", 15 },
                { "rtlsdr", "RTL-SDR", "rtl_sdr_source", "RTL-SDR Source", 60 },
            };

            const int MAX_RADIOS = 8;
            const int MAX_BANDS = 16;
            const std::vector<int> fftSizes = { 524288, 262144, 131072, 65536, 32768, 16384, 8192, 4096, 2048, 1024 };

            // Guards everything below. Recursive because source modules call back into
            // onSampleRate while we are inside their menu or select handlers.
            std::recursive_mutex mtx;
            ConfigManager config;
            std::function<void(const std::string&)> frameHandler;
            std::mutex frameHandlerMtx;

            std::vector<std::unique_ptr<Radio>> radios;
            std::vector<std::shared_ptr<Band>> bands;
            Radio* activeRadio = NULL;
            bool running = false;
            std::string lastError;

            // Device ids found by the last full scan, made while all radios were stopped
            std::vector<std::string> devices;
            // Devices seen by the last check of the watcher, to tell a newly plugged device apart
            std::set<std::string> lastSeen;

            // Messages for the operator, shown once by the browser
            std::deque<json> notices;
            int noticeId = 0;

            // Looks for newly plugged devices while the monitor runs
            std::thread watcher;
            std::mutex watcherMtx;
            std::condition_variable watcherCnd;
            bool watching = false;
            const auto WATCH_INTERVAL = std::chrono::seconds(3);

            // Interference events that ended, newest last, and the log file they are also written to.
            // Guarded by eventsMtx only, since they arrive from the FFT threads.
            std::mutex eventsMtx;
            std::deque<json> history;
            std::map<int, std::string> bandNames;
            const size_t MAX_HISTORY = 200;

            const SourceType& sourceType() {
                std::string id = config.conf["sourceType"].get<std::string>();
                for (auto& t : sourceTypes) {
                    if (t.id == id) { return t; }
                }
                return sourceTypes[0];
            }

            // The config is only touched under mtx, so it is written out directly instead of auto-saved
            void saveConfig() {
                config.save();
            }

            void onSampleRate(double sampleRate) {
                std::lock_guard<std::recursive_mutex> lck(mtx);
                if (activeRadio) { activeRadio->setSampleRate(sampleRate); }
            }

            float holdSpeed() {
                return config.conf["fftHoldSpeed"].get<float>() / (config.conf["fftRate"].get<float>() * 10.0f);
            }

            float smoothingSpeed() {
                return std::min<float>(config.conf["fftSmoothingSpeed"].get<float>() / (config.conf["fftRate"].get<float>() * 10.0f), 1.0f);
            }

            void applyBandDisplay(Band& band) {
                band.setFFTHold(config.conf["fftHold"].get<bool>(), holdSpeed());
                band.setFFTSmoothing(config.conf["fftSmoothing"].get<bool>(), smoothingSpeed());
            }

            DetectorSettings detectorSettings() {
                const json& d = config.conf["interference"];
                DetectorSettings s;
                s.enabled = d.value("enabled", true);
                s.thresholdDb = d.value("thresholdDb", 10.0f);
                s.noiseRiseDb = d.value("noiseRiseDb", 3.0f);
                s.learnSeconds = d.value("learnSeconds", 10.0f);
                s.adaptMinutes = d.value("adaptMinutes", 5.0f);
                s.fftRate = config.conf["fftRate"].get<float>();
                return s;
            }

            std::string logPath() {
                return std::filesystem::absolute(core::args["root"].s() + "/interference_log.csv").string();
            }

            std::string localTime(int64_t ms) {
                if (ms <= 0) { return ""; }
                time_t t = (time_t)(ms / 1000);
                tm local;
#ifdef _WIN32
                localtime_s(&local, &t);
#else
                localtime_r(&t, &local);
#endif
                char buf[32];
                strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &local);
                char out[40];
                snprintf(out, sizeof(out), "%s.%03d", buf, (int)(ms % 1000));
                return out;
            }

            json eventJson(const InterferenceEvent& e) {
                return { { "id", e.id },
                         { "band", e.bandId },
                         { "type", e.type },
                         { "active", e.endMs == 0 },
                         { "start", e.startMs },
                         { "last", e.lastMs },
                         { "end", e.endMs },
                         { "duration", e.durationSeconds() },
                         { "center", e.centerHz },
                         { "low", e.lowHz },
                         { "high", e.highHz },
                         { "minCenter", e.minCenterHz },
                         { "maxCenter", e.maxCenterHz },
                         { "bandwidth", e.bandwidthHz },
                         { "peak", e.peakDb },
                         { "excess", e.excessDb },
                         { "snr", e.snrDb },
                         { "duty", e.dutyPercent() },
                         { "drift", e.driftHzPerSecond() },
                         { "period", e.periodMs },
                         { "appearances", e.appearances } };
            }

            // Called from the FFT threads when an event ends: kept for the browser and appended to the log
            void recordEvent(const InterferenceEvent& e) {
                std::lock_guard<std::mutex> lck(eventsMtx);
                history.push_back(eventJson(e));
                while (history.size() > MAX_HISTORY) { history.pop_front(); }

                std::string path = logPath();
                std::error_code ec;
                bool header = !std::filesystem::exists(path, ec) || std::filesystem::file_size(path, ec) == 0;
                std::ofstream log(path, std::ios::app);
                if (!log) { return; }
                if (header) {
                    log << "id,band,type,start,end,duration_s,center_hz,low_hz,high_hz,min_center_hz,max_center_hz,bandwidth_hz,"
                           "peak_db,excess_db,snr_db,duty_percent,drift_hz_per_s,period_ms,appearances\n";
                }
                auto it = bandNames.find(e.bandId);
                std::string name = (it != bandNames.end()) ? it->second : std::to_string(e.bandId);
                std::string quoted = "\"";
                for (char c : name) { quoted += (c == '"') ? std::string("\"\"") : std::string(1, c); }
                quoted += "\"";
                char nums[512];
                snprintf(nums, sizeof(nums), "%.3f,%.0f,%.0f,%.0f,%.0f,%.0f,%.0f,%.1f,%.1f,%.1f,%.1f,%.1f,%.0f,%d",
                         e.durationSeconds(), e.centerHz, e.lowHz, e.highHz, e.minCenterHz, e.maxCenterHz, e.bandwidthHz,
                         e.peakDb, e.excessDb, e.snrDb, e.dutyPercent(), e.driftHzPerSecond(), e.periodMs, e.appearances);
                log << e.id << "," << quoted << "," << e.type << "," << localTime(e.startMs) << "," << localTime(e.endMs) << "," << nums << "\n";
            }

            // Hooks a new band up to the browser stream, the display settings and the detector
            void setupBand(Band& band) {
                band.onFrame = [](const std::string& frame) {
                    std::lock_guard<std::mutex> lck(frameHandlerMtx);
                    if (frameHandler) { frameHandler(frame); }
                };
                band.onEventClosed = recordEvent;
                applyBandDisplay(band);
                band.setDetection(detectorSettings());
            }

            std::shared_ptr<Band> findBand(int id) {
                for (auto& b : bands) {
                    if (b->id == id) { return b; }
                }
                throw std::runtime_error("Band not found");
            }

            Radio* radioOf(const std::shared_ptr<Band>& band) {
                for (auto& r : radios) {
                    if (std::find(r->bands.begin(), r->bands.end(), band) != r->bands.end()) { return r.get(); }
                }
                return NULL;
            }

            void saveBands() {
                json list = json::array();
                for (auto& b : bands) {
                    list.push_back({ { "id", b->id }, { "name", b->name }, { "frequency", b->frequency }, { "radioSetting", b->radioSetting } });
                }
                config.conf["bands"] = list;
                saveConfig();

                std::lock_guard<std::mutex> lck(eventsMtx);
                bandNames.clear();
                for (auto& b : bands) { bandNames[b->id] = b->name; }
            }

            void notify(const std::string& text) {
                flog::info("Web monitor: {0}", text);
                notices.push_back({ { "id", ++noticeId }, { "text", text } });
                while (notices.size() > 10) { notices.pop_front(); }
            }

            // A band tied to a radio without its device falls back to the automatic choice, and is tied again when the device returns
            bool isTied(const Band& band) {
                return band.radioSetting >= 0 && band.radioSetting < (int)radios.size() && radios[band.radioSetting]->online;
            }

            // Bands tied to a radio go there. The others are spread, in order, over the online radios with the fewest bands.
            void assignBands() {
                typedef std::vector<std::shared_ptr<Band>> Group;
                std::vector<Group> groups(radios.size());
                std::vector<size_t> online;
                for (size_t i = 0; i < radios.size(); i++) {
                    if (radios[i]->online) { online.push_back(i); }
                }
                if (!online.empty()) {
                    for (auto& b : bands) {
                        if (isTied(*b)) { groups[b->radioSetting].push_back(b); }
                    }
                    for (auto& b : bands) {
                        if (isTied(*b)) { continue; }
                        size_t least = *std::min_element(online.begin(), online.end(), [&](size_t l, size_t r) { return groups[l].size() < groups[r].size(); });
                        groups[least].push_back(b);
                    }
                }
                for (size_t i = 0; i < radios.size(); i++) {
                    radios[i]->setBands(groups[i]);
                }
            }

            // --- devices ---

            bool canManageDevices() {
                if (radios.empty()) { return false; }
                auto h = radios[0]->handler;
                return h->listDevicesHandler && h->selectDeviceHandler && h->selectedDeviceHandler;
            }

            std::vector<std::string> listDevices() {
                auto h = radios[0]->handler;
                return h->listDevicesHandler(h->ctx);
            }

            // Only while stopped: an open device may be missing from the list
            void scanDevices() {
                if (!canManageDevices()) { return; }
                devices = listDevices();
                lastSeen = std::set<std::string>(devices.begin(), devices.end());
            }

            std::string shortId(const std::string& id) {
                return id.size() > 16 ? id.substr(0, 16) : id;
            }

            // Gives every radio its own device from the last scan. A radio keeps its device if it is still there,
            // the preferred radio (the one the operator just changed) first. Radios left without a device go offline.
            // Only while stopped, selecting a device opens it.
            void assignDevices(int preferred = -1) {
                if (!canManageDevices()) {
                    for (auto& r : radios) { r->online = true; }
                    return;
                }
                std::set<std::string> available(devices.begin(), devices.end());
                std::set<std::string> used;
                std::vector<Radio*> order;
                if (preferred >= 0 && preferred < (int)radios.size()) { order.push_back(radios[preferred].get()); }
                for (auto& r : radios) {
                    if (r->id != preferred) { order.push_back(r.get()); }
                }

                std::vector<Radio*> unbound;
                for (Radio* r : order) {
                    std::string id = r->handler->selectedDeviceHandler(r->handler->ctx);
                    if (!id.empty() && available.count(id) && !used.count(id)) {
                        r->device = id;
                        r->online = true;
                        used.insert(id);
                    }
                    else {
                        unbound.push_back(r);
                    }
                }
                std::sort(unbound.begin(), unbound.end(), [](Radio* l, Radio* r) { return l->id < r->id; });

                Radio* prevActive = activeRadio;
                for (Radio* r : unbound) {
                    r->device = "";
                    r->online = false;
                    for (auto& id : devices) {
                        if (used.count(id)) { continue; }
                        used.insert(id); // Not tried again by the next radio if it cannot be opened
                        activeRadio = r;
                        bool ok = r->handler->selectDeviceHandler(id, r->handler->ctx);
                        activeRadio = prevActive;
                        if (ok) {
                            r->device = id;
                            r->online = true;
                            break;
                        }
                    }
                    if (!r->online) { flog::warn("Web monitor: radio {0} has no device", r->id + 1); }
                }
            }

            void stopLocked() {
                for (auto& r : radios) { r->stop(); }
                running = false;
                // Nothing is observed any more, so what was seen ends here
                for (auto& b : bands) { b->closeEvents(); }
            }

            void startLocked() {
                if (running) { return; }
                if (bands.empty()) { throw std::runtime_error("Add a band first"); }
                if (radios.empty()) { throw std::runtime_error("No radio available. Is the " + sourceType().name + " module built and in the modules directory?"); }
                bool anyOnline = std::any_of(radios.begin(), radios.end(), [](const std::unique_ptr<Radio>& r) { return r->online; });
                if (!anyOnline) { throw std::runtime_error("No " + sourceType().name + " connected. Plug one in, it is picked up automatically."); }
                int dwellMs = config.conf["dwellMs"].get<int>();
                int settleMs = config.conf["settleMs"].is_number() ? config.conf["settleMs"].get<int>() : sourceType().settleMs;
                for (auto& r : radios) { r->start(dwellMs, settleMs); }
                running = true;
            }

            // Create the module instances of the selected source type and one Radio for each
            void buildRadios() {
                stopLocked();
                radios.clear();
                lastError = "";

                const SourceType& type = sourceType();
                int count = std::clamp<int>(config.conf["radioCount"].get<int>(), 1, MAX_RADIOS);

                if (core::moduleManager.modules.find(type.module) == core::moduleManager.modules.end()) {
                    lastError = "The " + type.name + " source module is not loaded";
                    flog::error("Web monitor: {0}", lastError);
                    return;
                }

                for (int i = 0; i < count; i++) {
                    std::string instanceName = (i == 0) ? type.instanceName : (type.instanceName + " #" + std::to_string(i + 1));
                    std::string sourceName = (i == 0) ? type.name : instanceName;

                    if (core::moduleManager.instances.find(instanceName) == core::moduleManager.instances.end()) {
                        flog::info("Web monitor: creating instance '{0}'", instanceName);
                        if (core::moduleManager.createInstance(instanceName, type.module) < 0) { break; }
                        core::moduleManager.postInit(instanceName);
                    }

                    SourceManager::SourceHandler* handler = sigpath::sourceManager.getHandler(sourceName);
                    if (!handler) {
                        flog::error("Web monitor: source '{0}' was not registered", sourceName);
                        break;
                    }

                    auto radio = std::make_unique<Radio>(i, instanceName, sourceName, handler);
                    radio->init(config.conf["fftSize"].get<int>(), config.conf["fftRate"].get<double>(), config.conf["fftWindow"].get<int>());

                    // Selecting the source makes the module report its sample rate
                    activeRadio = radio.get();
                    handler->selectHandler(handler->ctx);
                    activeRadio = NULL;

                    radios.push_back(std::move(radio));
                }
                assignDevices();
                assignBands();
            }

            // One radio per connected device, as on launch. The operator can still add or remove radios afterwards.
            void autoConfigure() {
                devices.clear(); // May be from another source type
                buildRadios(); // The module instances are needed to list the devices
                if (!canManageDevices()) { return; }
                scanDevices();
                int found = std::min<int>((int)devices.size(), MAX_RADIOS);
                if (found == 0) {
                    assignDevices();
                    assignBands();
                    notify("No " + sourceType().name + " found. Plug one in, it is picked up automatically.");
                    return;
                }
                if (found != config.conf["radioCount"].get<int>()) {
                    config.conf["radioCount"] = found;
                    saveConfig();
                    buildRadios();
                }
                else {
                    assignDevices();
                    assignBands();
                }
                notify(std::to_string(found) + " " + sourceType().name + (found > 1 ? " devices" : " device") + " found, " +
                       std::to_string(found) + (found > 1 ? " radios" : " radio") + " set up");
            }

            // Called by the watcher: adds a radio for each newly plugged device, or gives it to a radio without one
            void checkNewDevices() {
                std::lock_guard<std::recursive_mutex> lck(mtx);
                if (!canManageDevices()) { return; }
                std::vector<std::string> now = listDevices();
                std::vector<std::string> fresh;
                for (auto& id : now) {
                    if (lastSeen.count(id)) { continue; }
                    bool inUse = std::any_of(radios.begin(), radios.end(), [&](const std::unique_ptr<Radio>& r) { return r->online && r->device == id; });
                    if (!inUse) { fresh.push_back(id); }
                }
                lastSeen = std::set<std::string>(now.begin(), now.end());
                if (fresh.empty()) { return; }

                bool wasRunning = running;
                stopLocked();
                scanDevices();

                int offline = (int)std::count_if(radios.begin(), radios.end(), [](const std::unique_ptr<Radio>& r) { return !r->online; });
                int count = std::min<int>((int)radios.size() + std::max<int>(0, (int)fresh.size() - offline), MAX_RADIOS);
                if (count != (int)radios.size()) {
                    config.conf["radioCount"] = count;
                    saveConfig();
                    buildRadios();
                }
                else {
                    assignDevices();
                    assignBands();
                }

                for (auto& id : fresh) {
                    auto it = std::find_if(radios.begin(), radios.end(), [&](const std::unique_ptr<Radio>& r) { return r->online && r->device == id; });
                    if (it != radios.end()) {
                        notify("New " + sourceType().name + " connected (" + shortId(id) + "), used as Radio " + std::to_string((*it)->id + 1));
                    }
                    else {
                        notify("New " + sourceType().name + " connected (" + shortId(id) + "), but it could not be used");
                    }
                }

                if (wasRunning) {
                    try { startLocked(); }
                    catch (const std::exception& e) { lastError = e.what(); }
                }
            }

            void watchDevices() {
                while (true) {
                    {
                        std::unique_lock<std::mutex> lck(watcherMtx);
                        if (watcherCnd.wait_for(lck, WATCH_INTERVAL, [] { return !watching; })) { return; }
                    }
                    checkNewDevices();
                }
            }

            json listNames(const std::string& dir) {
                json names = json::array();
                std::error_code ec;
                for (const auto& file : std::filesystem::directory_iterator(dir, ec)) {
                    if (file.path().extension() != ".json") { continue; }
                    try {
                        std::ifstream f(file.path());
                        json j = json::parse(f);
                        names.push_back({ { "name", j.value("name", file.path().stem().string()) }, { "file", file.path().filename().string() } });
                    }
                    catch (const std::exception&) {}
                }
                return names;
            }
        }

        void init() {
            std::lock_guard<std::recursive_mutex> lck(mtx);

            // Display defaults are the ones of desktop SDR++ (core.cpp)
            json def = json({});
            def["sourceType"] = "bladerf";
            def["radioCount"] = 1;
            def["dwellMs"] = 100;
            def["settleMs"] = nullptr;
            def["bands"] = json::array({ { { "id", 1 }, { "name", "Band 1" }, { "frequency", 100000000.0 } } });
            def["fftSize"] = 65536;
            def["fftRate"] = 20;
            def["fftWindow"] = 2;
            def["showWaterfall"] = true;
            def["fftHold"] = false;
            def["fftHoldSpeed"] = 60;
            def["fftSmoothing"] = false;
            def["fftSmoothingSpeed"] = 100;
            def["fftMode"] = "line";
            def["persistenceSpeed"] = 20;
            def["colorMap"] = "Classic";
            def["theme"] = "Dark";
            def["min"] = -120.0;
            def["max"] = 0.0;
            def["interference"] = { { "enabled", true }, { "thresholdDb", 10.0 }, { "noiseRiseDb", 3.0 }, { "learnSeconds", 10.0 }, { "adaptMinutes", 5.0 } };
            config.setPath(core::args["root"].s() + "/web_config.json");
            config.load(def);

            // Keys added by newer versions
            for (auto& [key, value] : def.items()) {
                if (!config.conf.contains(key)) { config.conf[key] = value; }
            }

            for (auto& b : config.conf["bands"]) {
                auto band = std::make_shared<Band>(b["id"].get<int>(), b["name"].get<std::string>(), b["frequency"].get<double>());
                band->radioSetting = b.value("radioSetting", -1);
                setupBand(*band);
                bands.push_back(band);
            }
            {
                std::lock_guard<std::mutex> elck(eventsMtx);
                for (auto& b : bands) { bandNames[b->id] = b->name; }
            }

            core::webSampleRateHandler = onSampleRate;
            autoConfigure();

            watching = true;
            watcher = std::thread(watchDevices);
        }

        void shutdown() {
            {
                std::lock_guard<std::mutex> lck(watcherMtx);
                watching = false;
            }
            watcherCnd.notify_all();
            if (watcher.joinable()) { watcher.join(); }

            std::lock_guard<std::recursive_mutex> lck(mtx);
            stopLocked();
            radios.clear();
            config.save();
        }

        void setFrameHandler(std::function<void(const std::string&)> handler) {
            std::lock_guard<std::mutex> lck(frameHandlerMtx);
            frameHandler = handler;
        }

        std::string resourcesDirectory() {
            core::configManager.acquire();
            std::string dir = core::configManager.conf["resourcesDirectory"].get<std::string>();
            core::configManager.release();
            return std::filesystem::absolute(dir).string();
        }

        json getState() {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            json state;
            state["running"] = running;
            state["sourceType"] = sourceType().id;
            state["sourceTypes"] = json::array();
            for (auto& t : sourceTypes) {
                state["sourceTypes"].push_back({ { "id", t.id }, { "name", t.name } });
            }
            state["radioCount"] = config.conf["radioCount"];
            state["dwellMs"] = config.conf["dwellMs"];
            state["settleMs"] = config.conf["settleMs"].is_number() ? config.conf["settleMs"].get<int>() : sourceType().settleMs;

            state["bands"] = json::array();
            for (auto& b : bands) {
                Radio* r = radioOf(b);
                state["bands"].push_back({ { "id", b->id },
                                           { "name", b->name },
                                           { "frequency", b->frequency },
                                           { "radio", r ? r->id : -1 },
                                           { "radioSetting", (b->radioSetting >= 0 && b->radioSetting < (int)radios.size()) ? b->radioSetting : -1 },
                                           { "sampleRate", r ? r->getSampleRate() : 0.0 } });
            }

            state["radios"] = json::array();
            std::string error = lastError;
            for (auto& r : radios) {
                json ids = json::array();
                for (auto& b : r->bands) { ids.push_back(b->id); }
                bool receiving = r->isReceiving();
                state["radios"].push_back({ { "id", r->id },
                                            { "name", r->sourceName },
                                            { "sampleRate", r->getSampleRate() },
                                            { "bands", ids },
                                            { "receiving", receiving },
                                            { "device", r->device },
                                            { "online", r->online } });
                if (running && !r->bands.empty() && !receiving && !r->isStarting() && error.empty()) {
                    error = "No data from radio " + std::to_string(r->id + 1) + " (" + r->sourceName + "). Check that the device is connected and selected in the Source menu.";
                }
            }
            int wanted = config.conf["radioCount"].get<int>();
            if ((int)radios.size() < wanted && error.empty()) {
                error = "Only " + std::to_string(radios.size()) + " of " + std::to_string(wanted) + " radios could be set up";
            }
            state["error"] = error;
            state["notices"] = json(std::vector<json>(notices.begin(), notices.end()));

            json display;
            for (auto key : { "fftSize", "fftRate", "fftWindow", "showWaterfall", "fftHold", "fftHoldSpeed", "fftSmoothing", "fftSmoothingSpeed", "fftMode", "persistenceSpeed", "colorMap", "theme", "min", "max" }) {
                display[key] = config.conf[key];
            }
            state["display"] = display;
            state["fftSizes"] = fftSizes;

            std::string res = resourcesDirectory();
            state["colorMaps"] = listNames(res + "/colormaps");
            state["themes"] = listNames(res + "/themes");
            return state;
        }

        void start() {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            if (!running) {
                // Pick up devices that were unplugged or plugged since the last scan
                scanDevices();
                assignDevices();
                assignBands();
            }
            startLocked();
        }

        void stop() {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            stopLocked();
        }

        void setSetup(const json& setup) {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            bool rebuild = false;
            bool typeChanged = false;

            if (setup.contains("sourceType")) {
                std::string id = setup["sourceType"].get<std::string>();
                bool known = std::any_of(sourceTypes.begin(), sourceTypes.end(), [&](const SourceType& t) { return t.id == id; });
                if (!known) { throw std::runtime_error("Unknown source type"); }
                if (id != config.conf["sourceType"].get<std::string>()) {
                    config.conf["sourceType"] = id;
                    config.conf["settleMs"] = nullptr;
                    rebuild = true;
                    typeChanged = true;
                }
            }
            if (setup.contains("radioCount")) {
                int count = setup["radioCount"].get<int>();
                if (count < 1 || count > MAX_RADIOS) { throw std::runtime_error("Radio count must be between 1 and " + std::to_string(MAX_RADIOS)); }
                if (count != config.conf["radioCount"].get<int>()) {
                    config.conf["radioCount"] = count;
                    rebuild = true;
                }
            }
            bool timing = false;
            if (setup.contains("dwellMs")) {
                int dwell = setup["dwellMs"].get<int>();
                if (dwell < 10 || dwell > 10000) { throw std::runtime_error("Dwell time must be between 10 and 10000 ms"); }
                timing = timing || (dwell != config.conf["dwellMs"].get<int>());
                config.conf["dwellMs"] = dwell;
            }
            if (setup.contains("settleMs")) {
                int settle = setup["settleMs"].get<int>();
                if (settle < 0 || settle > 1000) { throw std::runtime_error("Settle time must be between 0 and 1000 ms"); }
                timing = true;
                config.conf["settleMs"] = settle;
            }
            saveConfig();

            bool wasRunning = running;
            if (typeChanged) {
                autoConfigure();
            }
            else if (rebuild) {
                buildRadios();
            }
            else if (timing && wasRunning) {
                stopLocked();
            }
            if (wasRunning && !running && (rebuild || timing)) { startLocked(); }
        }

        int addBand(const json& j) {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            if ((int)bands.size() >= MAX_BANDS) { throw std::runtime_error("No more than " + std::to_string(MAX_BANDS) + " bands"); }
            double frequency = j.value("frequency", 100000000.0);
            if (frequency < 0) { throw std::runtime_error("Invalid frequency"); }

            int id = 1;
            for (auto& b : bands) { id = std::max<int>(id, b->id + 1); }
            auto band = std::make_shared<Band>(id, j.value("name", "Band " + std::to_string(id)), frequency);
            setupBand(*band);

            bool wasRunning = running;
            stopLocked();
            bands.push_back(band);
            assignBands();
            saveBands();
            if (wasRunning) { startLocked(); }
            return id;
        }

        void updateBand(int id, const json& j) {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            auto band = findBand(id);
            if (j.contains("name")) { band->name = j["name"].get<std::string>(); }
            if (j.contains("frequency")) {
                double frequency = j["frequency"].get<double>();
                if (frequency < 0) { throw std::runtime_error("Invalid frequency"); }
                band->frequency = frequency;
                Radio* r = radioOf(band);
                if (r) { r->retune(band); }
            }
            if (j.contains("radioSetting")) {
                int radio = j["radioSetting"].get<int>();
                if (radio < -1 || radio >= (int)radios.size()) { throw std::runtime_error("Radio not found"); }
                if (radio != band->radioSetting) {
                    band->radioSetting = radio;
                    bool wasRunning = running;
                    stopLocked();
                    assignBands();
                    if (wasRunning) { startLocked(); }
                }
            }
            saveBands();
        }

        void removeBand(int id) {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            auto band = findBand(id);
            bool wasRunning = running;
            stopLocked();
            band->closeEvents();
            bands.erase(std::find(bands.begin(), bands.end(), band));
            assignBands();
            saveBands();
            if (wasRunning && !bands.empty()) { startLocked(); }
        }

        void setView(int id, double offset, double bandwidth, int points) {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            findBand(id)->setView(offset, bandwidth, points);
        }

        void setDisplay(const json& d) {
            std::lock_guard<std::recursive_mutex> lck(mtx);

            if (d.contains("fftSize")) {
                int size = d["fftSize"].get<int>();
                if (std::find(fftSizes.begin(), fftSizes.end(), size) == fftSizes.end()) { throw std::runtime_error("Unsupported FFT size"); }
                config.conf["fftSize"] = size;
                for (auto& r : radios) { r->setFFTSize(size); }
            }
            if (d.contains("fftRate")) {
                int rate = std::clamp<int>(d["fftRate"].get<int>(), 1, 200);
                config.conf["fftRate"] = rate;
                for (auto& r : radios) { r->setFFTRate(rate); }
            }
            if (d.contains("fftWindow")) {
                int window = std::clamp<int>(d["fftWindow"].get<int>(), 0, 2);
                config.conf["fftWindow"] = window;
                for (auto& r : radios) { r->setFFTWindow(window); }
            }
            for (auto key : { "showWaterfall", "fftHold", "fftSmoothing" }) {
                if (d.contains(key)) { config.conf[key] = d[key].get<bool>(); }
            }
            for (auto key : { "fftHoldSpeed", "fftSmoothingSpeed" }) {
                if (d.contains(key)) { config.conf[key] = std::max<int>(1, d[key].get<int>()); }
            }
            if (d.contains("fftMode")) {
                std::string mode = d["fftMode"].get<std::string>();
                if (mode != "line" && mode != "persistence") { throw std::runtime_error("Unknown FFT mode"); }
                config.conf["fftMode"] = mode;
            }
            if (d.contains("persistenceSpeed")) { config.conf["persistenceSpeed"] = std::clamp<int>(d["persistenceSpeed"].get<int>(), 1, 100); }
            for (auto key : { "colorMap", "theme" }) {
                if (d.contains(key)) { config.conf[key] = d[key].get<std::string>(); }
            }
            for (auto key : { "min", "max" }) {
                if (d.contains(key)) { config.conf[key] = std::clamp<double>(d[key].get<double>(), -160.0, 0.0); }
            }
            DetectorSettings detection = detectorSettings();
            for (auto& b : bands) {
                applyBandDisplay(*b);
                b->setDetection(detection);
            }
            saveConfig();
        }

        json getInterference() {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            json out;
            out["settings"] = config.conf["interference"];
            out["logFile"] = logPath();
            out["bands"] = json::array();
            out["active"] = json::array();
            for (auto& b : bands) {
                std::vector<InterferenceEvent> active;
                DetectorStatus st;
                b->detection(active, st);
                out["bands"].push_back({ { "id", b->id },
                                         { "enabled", st.enabled },
                                         { "learning", st.learning },
                                         { "learnProgress", st.learnProgress },
                                         { "noiseFloor", st.noiseFloorDb },
                                         { "baselineFloor", st.baselineFloorDb },
                                         { "active", st.active } });
                for (auto& e : active) { out["active"].push_back(eventJson(e)); }
            }
            std::lock_guard<std::mutex> elck(eventsMtx);
            out["history"] = json(std::vector<json>(history.rbegin(), history.rend()));
            return out;
        }

        void setInterference(const json& d) {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            json& conf = config.conf["interference"];
            if (d.contains("enabled")) { conf["enabled"] = d["enabled"].get<bool>(); }
            auto number = [&](const char* key, double lo, double hi, const char* what) {
                if (!d.contains(key)) { return; }
                double v = d[key].get<double>();
                if (v < lo || v > hi) { throw std::runtime_error(std::string(what) + " must be between " + std::to_string((int)lo) + " and " + std::to_string((int)hi)); }
                conf[key] = v;
            };
            number("thresholdDb", 1, 60, "Threshold");
            number("noiseRiseDb", 1, 40, "Noise rise");
            number("learnSeconds", 1, 600, "Learn time");
            number("adaptMinutes", 1, 120, "Adapt time");
            saveConfig();
            DetectorSettings detection = detectorSettings();
            for (auto& b : bands) { b->setDetection(detection); }
        }

        void relearn(int band) {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            if (band >= 0) {
                findBand(band)->relearn();
                return;
            }
            for (auto& b : bands) { b->relearn(); }
        }

        void clearHistory() {
            std::lock_guard<std::mutex> lck(eventsMtx);
            history.clear();
        }

        json getMenu(int radio, const json& action) {
            std::lock_guard<std::recursive_mutex> lck(mtx);
            if (radio < 0 || radio >= (int)radios.size()) { throw std::runtime_error("Radio not found"); }
            Radio* r = radios[radio].get();
            activeRadio = r;

            // Same sequence as server::renderUI: apply the action, then record the resulting menu
            SmGui::DrawListElem none;
            none.type = SmGui::DRAW_LIST_ELEM_TYPE_BOOL;
            none.b = false;
            if (!action.is_null()) {
                SmGui::DrawListElem value = none;
                std::string type = action.value("type", "void");
                if (type == "bool") { value.type = SmGui::DRAW_LIST_ELEM_TYPE_BOOL; value.b = action["value"].get<bool>(); }
                else if (type == "int") { value.type = SmGui::DRAW_LIST_ELEM_TYPE_INT; value.i = action["value"].get<int>(); }
                else if (type == "float") { value.type = SmGui::DRAW_LIST_ELEM_TYPE_FLOAT; value.f = action["value"].get<float>(); }
                else if (type == "string") { value.type = SmGui::DRAW_LIST_ELEM_TYPE_STRING; value.str = action["value"].get<std::string>(); }
                std::string id = action["id"].get<std::string>();
                SmGui::setDiff(id, value);
                r->handler->menuHandler(r->handler->ctx);

                // The device controls are only enabled while stopped
                if (!running && canManageDevices()) {
                    if (id.rfind("Refresh##", 0) == 0) { scanDevices(); }
                    assignDevices(radio);
                    assignBands();
                    activeRadio = r;
                }
            }

            SmGui::DrawList dl;
            SmGui::setDiff("", none);
            SmGui::startRecord(&dl);
            r->handler->menuHandler(r->handler->ctx);
            SmGui::stopRecord();
            activeRadio = NULL;

            json elements = json::array();
            for (auto& e : dl.elements) {
                if (e.type == SmGui::DRAW_LIST_ELEM_TYPE_DRAW_STEP) { elements.push_back({ { "step", (int)e.step }, { "sync", e.forceSync } }); }
                else if (e.type == SmGui::DRAW_LIST_ELEM_TYPE_BOOL) { elements.push_back({ { "v", e.b } }); }
                else if (e.type == SmGui::DRAW_LIST_ELEM_TYPE_INT) { elements.push_back({ { "v", e.i } }); }
                else if (e.type == SmGui::DRAW_LIST_ELEM_TYPE_FLOAT) { elements.push_back({ { "v", e.f } }); }
                else {
                    // Combo items are separated by NUL characters, which the browser splits on
                    elements.push_back({ { "v", e.str } });
                }
            }
            return { { "radio", radio }, { "name", r->sourceName }, { "running", r->isRunning() }, { "elements", elements } };
        }
    }
}
