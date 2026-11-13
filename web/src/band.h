#pragma once
#include <string>
#include <vector>
#include <mutex>
#include <functional>
#include <stdint.h>
#include "detector.h"

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

        // Interference detection on the whole band, independent of the view
        void setDetection(const DetectorSettings& settings);
        void relearn();
        void closeEvents();
        void detection(std::vector<InterferenceEvent>& active, DetectorStatus& status);

        const int id;
        std::string name;
        double frequency;

        // Index of the radio this band is tied to, -1 lets the engine pick one
        int radioSetting = -1;

        // Receives every encoded frame
        std::function<void(const std::string&)> onFrame;

        // Receives every interference event that ended, called without the band lock held
        std::function<void(const InterferenceEvent&)> onEventClosed;

    private:
        std::mutex mtx;
        double viewOffset = 0.0;
        double viewBandwidth = 0.0;
        int points = 1024;

        bool fftHold = false;
        float fftHoldSpeed = 0.3f;
        bool fftSmoothing = false;
        float smoothingAlpha = 0.5f;
        // Smoothing and hold run on the whole FFT before the view is cut out, so changing the view keeps them.
        // They start over when switched on or when the spectrum changes (frequency, bandwidth or FFT size).
        bool smoothingValid = false;
        bool holdValid = false;
        double historyFrequency = 0.0;
        double historyBandwidth = 0.0;
        std::vector<float> rawSmoothed;
        std::vector<float> rawHold;

        std::vector<float> latest;
        std::vector<float> hold;
        std::vector<float> scratch;

        Detector detector;
        std::vector<InterferenceEvent> closedEvents;
        void emitClosed();
    };
}
