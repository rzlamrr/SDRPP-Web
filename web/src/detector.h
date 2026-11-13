#pragma once
#include <cmath>
#include <string>
#include <vector>
#include <stdint.h>

namespace web {
    // Settings of the interference detector, shared by all bands
    struct DetectorSettings {
        bool enabled = true;
        float thresholdDb = 10.0f;  // A bin is occupied when it is this much above its baseline and above the noise floor
        float noiseRiseDb = 3.0f;   // Rise of the noise floor over its baseline that counts as wideband interference
        float learnSeconds = 10.0f; // Data used to learn the baseline, in seconds at the FFT rate
        float adaptMinutes = 5.0f;  // Time constant of the slow baseline update of quiet bins
        float fftRate = 20.0f;      // FFT lines per second of the radios
    };

    // One interference event: something present now that was not there while the baseline was learned
    struct InterferenceEvent {
        int id = 0;
        int bandId = 0;
        std::string type; // "narrowband", "wideband", "swept", "pulsed" or "noise"

        // Wall clock, milliseconds since the epoch. endMs is 0 while the event is active.
        int64_t startMs = 0;
        int64_t lastMs = 0;
        int64_t endMs = 0;

        // Latest occupied range and power weighted center
        double lowHz = 0.0;
        double highHz = 0.0;
        double centerHz = 0.0;
        double firstCenterHz = 0.0;
        double minCenterHz = 0.0;
        double maxCenterHz = 0.0;
        double bandwidthHz = 0.0; // Widest occupied bandwidth seen

        float peakDb = -INFINITY;   // Highest bin level
        float excessDb = 0.0f;      // Highest level over the baseline (for "noise": rise of the noise floor)
        float snrDb = 0.0f;         // Highest level over the noise floor

        int framesSeen = 0;  // Frames in which it was detected
        int framesTotal = 0; // Frames received since it first appeared
        int framesSpan = 0;  // Frames received from its first to its last detection
        int appearances = 0; // Times it came back after a frame without it
        double periodMs = 0.0; // Mean time between appearances, 0 when it did not repeat

        // Tracking
        int missed = 0;
        bool seen = false;
        bool confirmed = false;
        int64_t lastAppearMs = 0;
        double periodSumMs = 0.0;
        int periodCount = 0;

        double durationSeconds() const { return (double)((endMs ? endMs : lastMs) - startMs) / 1000.0; }
        float dutyPercent() const { return framesSpan > 0 ? 100.0f * (float)framesSeen / (float)framesSpan : 0.0f; }
        double driftHzPerSecond() const {
            double d = durationSeconds();
            return d > 0.0 ? (centerHz - firstCenterHz) / d : 0.0;
        }
    };

    struct DetectorStatus {
        bool enabled = false;
        bool learning = true;
        float learnProgress = 0.0f; // 0 to 1
        float noiseFloorDb = 0.0f;
        float baselineFloorDb = 0.0f;
        int active = 0;
    };

    // Finds interference in the FFT lines of one band by comparing them with a learned baseline.
    // Not thread safe, the band calls it under its own lock.
    class Detector {
    public:
        // raw is the whole FFT of the band. Events that end are appended to closed.
        void process(const float* raw, int rawSize, double centerFreq, double bandwidth, int64_t nowMs, std::vector<InterferenceEvent>& closed);

        void setSettings(const DetectorSettings& settings, std::vector<InterferenceEvent>& closed);

        // Forget the baseline and learn it again from the next lines
        void relearn(int64_t nowMs, std::vector<InterferenceEvent>& closed);

        // End every active event, e.g. when the radio stops
        void closeAll(int64_t nowMs, std::vector<InterferenceEvent>& closed);

        // Confirmed active events
        std::vector<InterferenceEvent> activeEvents() const;
        DetectorStatus status() const;

        int bandId = 0;

        // Resolution the detector works at, the raw FFT is reduced to this many bins
        static constexpr int BINS = 4096;

    private:
        struct Run {
            int lo, hi;
            float peak, excess, snr;
            double center;
        };

        void reset(int64_t nowMs, std::vector<InterferenceEvent>& closed);
        void close(InterferenceEvent& e, int64_t nowMs, std::vector<InterferenceEvent>& closed);
        void classify(InterferenceEvent& e) const;
        void see(InterferenceEvent& e, double lowHz, double highHz, double centerHz, float peak, float excess, float snr, int64_t nowMs);
        double binFreq(double bin) const;
        int learnFrames() const;
        int holdFrames() const;

        DetectorSettings settings;
        double baseFreq = -1.0;
        double baseBandwidth = -1.0;
        int baseRawSize = 0;
        int bins = 0;
        double binHz = 0.0;
        int64_t lastFrameMs = 0;

        std::vector<float> current;
        std::vector<float> baseline;
        std::vector<float> scratch;
        std::vector<uint8_t> flagged;
        std::vector<Run> runs;
        std::vector<int> owners;
        int learned = 0;
        bool ready = false;
        float floorDb = 0.0f;
        float shownFloorDb = 0.0f;
        float baseFloorDb = 0.0f;
        int frame = 0;

        std::vector<InterferenceEvent> events;
        InterferenceEvent noise;
        bool noiseActive = false;
    };
}
