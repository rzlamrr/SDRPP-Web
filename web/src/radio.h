#pragma once
#include <signal_path/signal_path.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "band.h"

namespace web {
    // One receiver: a source module instance feeding its own IQFrontEnd.
    // With several bands assigned it visits them in turn.
    class Radio {
    public:
        Radio(int id, std::string instanceName, std::string sourceName, SourceManager::SourceHandler* handler);
        ~Radio();

        void init(int fftSize, double fftRate, int fftWindow);

        void setBands(std::vector<std::shared_ptr<Band>> bands);
        void start(int dwellMs, int settleMs);
        void stop();

        // Apply a new frequency of a band of this radio
        void retune(const std::shared_ptr<Band>& band);

        void setSampleRate(double sampleRate);
        void setFFTSize(int size);
        void setFFTRate(double rate);
        void setFFTWindow(int window);

        double getSampleRate() { return sampleRate; }
        bool isRunning() { return running; }

        // True if FFT data arrived recently. The source modules do not report a failed start.
        bool isReceiving();

        // True for the first seconds after start, while the device opens and no data can be expected yet
        bool isStarting();

        const int id;
        const std::string instanceName;
        const std::string sourceName;
        SourceManager::SourceHandler* const handler;
        std::vector<std::shared_ptr<Band>> bands;

    private:
        static float* acquireFFTBuffer(void* ctx);
        static void releaseFFTBuffer(void* ctx);
        void hopWorker(int dwellMs, int settleMs);
        void tuneTo(const std::shared_ptr<Band>& band);

        // Largest size offered by the Display menu
        static constexpr int MAX_FFT_SIZE = 524288;

        IQFrontEnd frontEnd;
        std::atomic<double> sampleRate{ 1000000.0 };
        std::atomic<int> fftSize{ 65536 };
        std::atomic<bool> resizing{ false };

        // Raw FFT, locked between acquire and release like the waterfall buffer in SDR++
        std::mutex rawMtx;
        std::vector<float> raw;

        // Band currently being received, NULL while the radio settles after a retune
        std::mutex currentMtx;
        std::shared_ptr<Band> current;

        std::atomic<bool> running{ false };
        std::thread hopThread;
        std::mutex hopMtx;
        std::condition_variable hopCnd;

        std::atomic<int64_t> lastFrameMs{ 0 };
        std::atomic<int64_t> startedMs{ 0 };
    };
}
