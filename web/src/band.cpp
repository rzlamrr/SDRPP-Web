#include "band.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace web {
    namespace {
        // Same max-hold decimation as doZoom() in gui/widgets/waterfall.h
        void doZoom(double offset, double width, int inSize, int outSize, const float* in, float* out) {
            if (offset < 0) { offset = 0; }
            double factor = width / (double)outSize;
            int sFactor = std::max<int>(1, (int)ceil(factor));
            double id = offset;
            for (int i = 0; i < outSize; i++) {
                int sId = std::min<int>((int)id, inSize - 1);
                int uFactor = (sId + sFactor > inSize) ? (inSize - sId) : sFactor;
                float maxVal = -INFINITY;
                for (int j = 0; j < uFactor; j++) {
                    if (in[sId + j] > maxVal) { maxVal = in[sId + j]; }
                }
                out[i] = maxVal;
                id += factor;
            }
        }

        template <typename T>
        void put(std::string& out, size_t& pos, T value) {
            memcpy(&out[pos], &value, sizeof(T));
            pos += sizeof(T);
        }

        void putLine(std::string& out, size_t& pos, const std::vector<float>& line) {
            for (float v : line) {
                float c = std::isfinite(v) ? v * 100.0f : -32768.0f;
                put<int16_t>(out, pos, (int16_t)std::clamp<float>(c, -32768.0f, 32767.0f));
            }
        }

        int64_t wallMs() {
            return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        }
    }

    Band::Band(int id, std::string name, double frequency) : id(id), name(name), frequency(frequency) {
        detector.bandId = id;
    }

    // Hands the events that ended to the engine. Must be called without the lock held.
    void Band::emitClosed() {
        std::vector<InterferenceEvent> events;
        {
            std::lock_guard<std::mutex> lck(mtx);
            events.swap(closedEvents);
        }
        if (onEventClosed) {
            for (auto& e : events) { onEventClosed(e); }
        }
    }

    void Band::setDetection(const DetectorSettings& settings) {
        {
            std::lock_guard<std::mutex> lck(mtx);
            detector.setSettings(settings, closedEvents);
        }
        emitClosed();
    }

    void Band::relearn() {
        {
            std::lock_guard<std::mutex> lck(mtx);
            detector.relearn(wallMs(), closedEvents);
        }
        emitClosed();
    }

    void Band::closeEvents() {
        {
            std::lock_guard<std::mutex> lck(mtx);
            detector.closeAll(wallMs(), closedEvents);
        }
        emitClosed();
    }

    void Band::detection(std::vector<InterferenceEvent>& active, DetectorStatus& status) {
        std::lock_guard<std::mutex> lck(mtx);
        active = detector.activeEvents();
        status = detector.status();
    }

    void Band::setView(double offset, double bandwidth, int points) {
        std::lock_guard<std::mutex> lck(mtx);
        viewOffset = offset;
        viewBandwidth = bandwidth;
        this->points = std::clamp<int>(points, 64, 4096);
    }

    void Band::resetView() {
        std::lock_guard<std::mutex> lck(mtx);
        viewOffset = 0.0;
        viewBandwidth = 0.0;
    }

    void Band::setFFTHold(bool enabled, float speed) {
        std::lock_guard<std::mutex> lck(mtx);
        // Only switching it on starts it over: the Display menu sends every setting on each change
        if (enabled && !fftHold) { holdValid = false; }
        fftHold = enabled;
        fftHoldSpeed = speed;
    }

    void Band::setFFTSmoothing(bool enabled, float speed) {
        std::lock_guard<std::mutex> lck(mtx);
        if (enabled && !fftSmoothing) { smoothingValid = false; }
        fftSmoothing = enabled;
        smoothingAlpha = std::clamp<float>(speed, 0.0f, 1.0f);
    }

    void Band::pushFFT(const float* raw, int rawSize, double bandwidth) {
        std::string frame;
        bool anyClosed = false;
        {
            std::lock_guard<std::mutex> lck(mtx);
            if (rawSize <= 0 || bandwidth <= 0) { return; }

            detector.process(raw, rawSize, frequency, bandwidth, wallMs(), closedEvents);
            anyClosed = !closedEvents.empty();

            // Resolve the view against the current bandwidth
            double vbw = (viewBandwidth <= 0.0 || viewBandwidth > bandwidth) ? bandwidth : viewBandwidth;
            double maxOffset = (bandwidth - vbw) / 2.0;
            double voff = std::clamp<double>(viewOffset, -maxOffset, maxOffset);

            double start = ((double)rawSize / 2.0) * (((voff - (vbw / 2.0)) / (bandwidth / 2.0)) + 1.0);
            double size = (vbw / bandwidth) * (double)rawSize;

            if ((int)latest.size() != points) {
                latest.assign(points, -INFINITY);
                hold.assign(points, -INFINITY);
            }

            // A different spectrum makes the history meaningless
            if (frequency != historyFrequency || bandwidth != historyBandwidth || (int)rawSmoothed.size() != rawSize) {
                historyFrequency = frequency;
                historyBandwidth = bandwidth;
                rawSmoothed.resize(rawSize);
                rawHold.resize(rawSize);
                smoothingValid = false;
                holdValid = false;
            }

            // FFT smoothing and hold, same behaviour as WaterFall::pushFFT, on the whole FFT
            const float* line = raw;
            if (fftSmoothing) {
                if (!smoothingValid) {
                    std::copy(raw, raw + rawSize, rawSmoothed.begin());
                    smoothingValid = true;
                }
                else {
                    float beta = 1.0f - smoothingAlpha;
                    for (int i = 0; i < rawSize; i++) {
                        float v = (rawSmoothed[i] * beta) + (raw[i] * smoothingAlpha);
                        rawSmoothed[i] = std::isfinite(v) ? v : raw[i];
                    }
                }
                line = rawSmoothed.data();
            }
            if (fftHold) {
                if (!holdValid) {
                    std::copy(line, line + rawSize, rawHold.begin());
                    holdValid = true;
                }
                else {
                    for (int i = 0; i < rawSize; i++) { rawHold[i] = std::max<float>(line[i], rawHold[i] - fftHoldSpeed); }
                }
            }

            doZoom(start, size, rawSize, points, line, latest.data());
            if (fftHold) { doZoom(start, size, rawSize, points, rawHold.data(), hold.data()); }

            // Signal to noise ratio of what is in view: peak over the lower quartile
            scratch = latest;
            std::nth_element(scratch.begin(), scratch.begin() + (points / 4), scratch.end());
            float floorDb = scratch[points / 4];
            float peakDb = *std::max_element(latest.begin(), latest.end());
            float snr = (std::isfinite(floorDb) && std::isfinite(peakDb)) ? (peakDb - floorDb) : 0.0f;

            frame.resize(FRAME_HEADER_SIZE + ((size_t)points * sizeof(int16_t) * (fftHold ? 2 : 1)));
            size_t pos = 0;
            put<uint32_t>(frame, pos, FRAME_MAGIC);
            put<int32_t>(frame, pos, id);
            put<double>(frame, pos, frequency);
            put<double>(frame, pos, bandwidth);
            put<double>(frame, pos, voff);
            put<double>(frame, pos, vbw);
            put<uint32_t>(frame, pos, (uint32_t)points);
            put<uint32_t>(frame, pos, fftHold ? FRAME_FLAG_HOLD : 0);
            put<float>(frame, pos, snr);
            put<uint32_t>(frame, pos, 0);
            putLine(frame, pos, latest);
            if (fftHold) { putLine(frame, pos, hold); }
        }
        if (onFrame) { onFrame(frame); }
        if (anyClosed) { emitClosed(); }
    }
}
