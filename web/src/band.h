#pragma once
#include <string>
#include <vector>
#include <mutex>
#include <functional>
#include <stdint.h>

namespace web {
    // Wire format of one FFT line sent to the browser (little endian):
    //   uint32 magic "SPF1", int32 bandId, double centerFreq, double bandwidth,
    //   double viewOffset, double viewBandwidth, uint32 count, uint32 flags, float snr, uint32 reserved,
    //   int16[count] FFT in 1/100 dB, then int16[count] FFT hold if FRAME_FLAG_HOLD is set.
    constexpr uint32_t FRAME_MAGIC = 0x31465053;
    constexpr int FRAME_HEADER_SIZE = 56;
    constexpr uint32_t FRAME_FLAG_HOLD = 1;

    // One monitored band: what the main window + waterfall widget are for the single band of desktop SDR++.
    class Band {
    public:
        Band(int id, std::string name, double frequency);

        // Called from the FFT thread of the radio that currently listens to this band
        void pushFFT(const float* raw, int rawSize, double bandwidth);

        // View (zoom), same meaning as waterfall.setViewOffset / setViewBandwidth. bandwidth <= 0 shows everything.
        void setView(double offset, double bandwidth, int points);
        void resetView();

        void setFFTHold(bool enabled, float speed);
        void setFFTSmoothing(bool enabled, float speed);

        const int id;
        std::string name;
        double frequency;

        // Index of the radio this band is tied to, -1 lets the engine pick one
        int radioSetting = -1;

        // Receives every encoded frame
        std::function<void(const std::string&)> onFrame;

    private:
        std::mutex mtx;
        double viewOffset = 0.0;
        double viewBandwidth = 0.0;
        int points = 1024;

        bool fftHold = false;
        float fftHoldSpeed = 0.3f;
        bool fftSmoothing = false;
        float smoothingAlpha = 0.5f;
        bool historyValid = false;

        std::vector<float> latest;
        std::vector<float> smoothed;
        std::vector<float> hold;
        std::vector<float> scratch;
    };
}
