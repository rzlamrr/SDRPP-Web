#include "band.h"
#include <algorithm>
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
    }

    Band::Band(int id, std::string name, double frequency) : id(id), name(name), frequency(frequency) {}

    void Band::setView(double offset, double bandwidth, int points) {
        std::lock_guard<std::mutex> lck(mtx);
        viewOffset = offset;
        viewBandwidth = bandwidth;
        this->points = std::clamp<int>(points, 64, 4096);
        historyValid = false;
    }

    void Band::resetView() {
        std::lock_guard<std::mutex> lck(mtx);
        viewOffset = 0.0;
        viewBandwidth = 0.0;
        historyValid = false;
    }

    void Band::setFFTHold(bool enabled, float speed) {
        std::lock_guard<std::mutex> lck(mtx);
        fftHold = enabled;
        fftHoldSpeed = speed;
        historyValid = false;
    }

    void Band::setFFTSmoothing(bool enabled, float speed) {
        std::lock_guard<std::mutex> lck(mtx);
        fftSmoothing = enabled;
        smoothingAlpha = std::clamp<float>(speed, 0.0f, 1.0f);
        historyValid = false;
    }

    void Band::pushFFT(const float* raw, int rawSize, double bandwidth) {
        std::string frame;
        {
            std::lock_guard<std::mutex> lck(mtx);
            if (rawSize <= 0 || bandwidth <= 0) { return; }

            // Resolve the view against the current bandwidth
            double vbw = (viewBandwidth <= 0.0 || viewBandwidth > bandwidth) ? bandwidth : viewBandwidth;
            double maxOffset = (bandwidth - vbw) / 2.0;
            double voff = std::clamp<double>(viewOffset, -maxOffset, maxOffset);

            double start = ((double)rawSize / 2.0) * (((voff - (vbw / 2.0)) / (bandwidth / 2.0)) + 1.0);
            double size = (vbw / bandwidth) * (double)rawSize;

            if ((int)latest.size() != points) {
                latest.assign(points, -INFINITY);
                smoothed.assign(points, -INFINITY);
                hold.assign(points, -INFINITY);
                historyValid = false;
            }
            doZoom(start, size, rawSize, points, raw, latest.data());

            // FFT smoothing and hold, same behaviour as WaterFall::pushFFT
            if (fftSmoothing) {
                if (!historyValid) { smoothed = latest; }
                float beta = 1.0f - smoothingAlpha;
                for (int i = 0; i < points; i++) {
                    smoothed[i] = (smoothed[i] * beta) + (latest[i] * smoothingAlpha);
                    if (!std::isfinite(smoothed[i])) { smoothed[i] = latest[i]; }
                }
                latest = smoothed;
            }
            if (fftHold) {
                if (!historyValid) { hold = latest; }
                for (int i = 0; i < points; i++) {
                    hold[i] = std::max<float>(latest[i], hold[i] - fftHoldSpeed);
                }
            }
            historyValid = true;

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
    }
}
