#include "radio.h"
#include <utils/flog.h>
#include <cmath>

namespace web {
    namespace {
        int64_t nowMs() {
            return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
        }
    }

    Radio::Radio(int id, std::string instanceName, std::string sourceName, SourceManager::SourceHandler* handler)
        : id(id), instanceName(instanceName), sourceName(sourceName), handler(handler) {}

    Radio::~Radio() {
        stop();
        frontEnd.stop();
    }

    void Radio::init(int fftSize, double fftRate, int fftWindow) {
        this->fftSize = fftSize;
        raw.assign(MAX_FFT_SIZE, -INFINITY);
        frontEnd.init(handler->stream, sampleRate, false, 1, false, fftSize, fftRate, (IQFrontEnd::FFTWindow)fftWindow, acquireFFTBuffer, releaseFFTBuffer, this);
        frontEnd.start();

        // Rebuilds the FFT path the way the display menu does at startup (this is what centers DC)
        frontEnd.setSampleRate(sampleRate);
    }

    void Radio::setBands(std::vector<std::shared_ptr<Band>> bands) {
        this->bands = bands;
    }

    void Radio::tuneTo(const std::shared_ptr<Band>& band) {
        handler->tuneHandler(band->frequency, handler->ctx);
    }

    void Radio::start(int dwellMs, int settleMs) {
        if (running || bands.empty()) { return; }

        tuneTo(bands[0]);
        handler->startHandler(handler->ctx);
        startedMs = nowMs();
        running = true;

        if (bands.size() > 1) {
            hopThread = std::thread(&Radio::hopWorker, this, dwellMs, settleMs);
        }
        else {
            std::lock_guard<std::mutex> lck(currentMtx);
            current = bands[0];
        }
        flog::info("Web radio {0} ({1}): started with {2} band(s)", id, sourceName, (int)bands.size());
    }

    void Radio::stop() {
        if (!running) { return; }
        running = false;
        {
            std::lock_guard<std::mutex> lck(hopMtx);
            hopCnd.notify_all();
        }
        if (hopThread.joinable()) { hopThread.join(); }
        {
            std::lock_guard<std::mutex> lck(currentMtx);
            current.reset();
        }
        handler->stopHandler(handler->ctx);
        flog::info("Web radio {0} ({1}): stopped", id, sourceName);
    }

    void Radio::retune(const std::shared_ptr<Band>& band) {
        // A radio that visits several bands picks the new frequency up on its next visit
        if (!running || bands.size() != 1) { return; }
        tuneTo(band);
        frontEnd.flushInputBuffer();
    }

    void Radio::hopWorker(int dwellMs, int settleMs) {
        size_t next = 0;
        while (running) {
            std::shared_ptr<Band> band = bands[next];
            next = (next + 1) % bands.size();

            // Nothing received while the tuner moves belongs to either band
            {
                std::lock_guard<std::mutex> lck(currentMtx);
                current.reset();
            }
            tuneTo(band);
            {
                std::unique_lock<std::mutex> lck(hopMtx);
                hopCnd.wait_for(lck, std::chrono::milliseconds(settleMs), [this] { return !running; });
            }
            if (!running) { break; }
            frontEnd.flushInputBuffer();
            {
                std::lock_guard<std::mutex> lck(currentMtx);
                current = band;
            }
            {
                std::unique_lock<std::mutex> lck(hopMtx);
                hopCnd.wait_for(lck, std::chrono::milliseconds(dwellMs), [this] { return !running; });
            }
        }
    }

    void Radio::setSampleRate(double sampleRate) {
        if (sampleRate <= 0) { return; }
        this->sampleRate = sampleRate;
        frontEnd.setSampleRate(sampleRate);
        for (auto& band : bands) { band->resetView(); }
        flog::info("Web radio {0} ({1}): sample rate {2}", id, sourceName, sampleRate);
    }

    void Radio::setFFTSize(int size) {
        if (size < 1024 || size > MAX_FFT_SIZE) { return; }

        // The buffer always has room for the largest FFT, so the FFT thread can never overrun it
        // while the front end switches size. Lines produced during the switch are dropped.
        resizing = true;
        frontEnd.setFFTSize(size);
        fftSize = size;
        resizing = false;
    }

    void Radio::setFFTRate(double rate) {
        frontEnd.setFFTRate(rate);
    }

    void Radio::setFFTWindow(int window) {
        frontEnd.setFFTWindow((IQFrontEnd::FFTWindow)window);
    }

    bool Radio::isReceiving() {
        return running && (nowMs() - lastFrameMs) < 1500;
    }

    bool Radio::isStarting() {
        return running && (nowMs() - startedMs) < 3000;
    }

    float* Radio::acquireFFTBuffer(void* ctx) {
        Radio* _this = (Radio*)ctx;
        _this->rawMtx.lock();
        return _this->raw.data();
    }

    void Radio::releaseFFTBuffer(void* ctx) {
        Radio* _this = (Radio*)ctx;
        std::shared_ptr<Band> band;
        {
            std::lock_guard<std::mutex> lck(_this->currentMtx);
            band = _this->current;
        }
        if (band && !_this->resizing) {
            band->pushFFT(_this->raw.data(), _this->fftSize, _this->sampleRate);
            _this->lastFrameMs = nowMs();
        }
        _this->rawMtx.unlock();
    }
}
