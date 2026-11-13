#pragma once
#include <json.hpp>
#include <functional>
#include <string>

namespace web {
    // The monitor itself: source type, radios, bands and display settings.
    // Every function is thread safe and throws std::runtime_error with a message meant for the operator.
    namespace engine {
        void init();
        void shutdown();

        // Receives every encoded FFT frame, from the FFT threads
        void setFrameHandler(std::function<void(const std::string&)> handler);

        nlohmann::json getState();

        void start();
        void stop();

        // { sourceType?, radioCount?, dwellMs?, settleMs? }
        void setSetup(const nlohmann::json& setup);

        int addBand(const nlohmann::json& band);
        void updateBand(int id, const nlohmann::json& band);
        void removeBand(int id);
        void setView(int id, double offset, double bandwidth, int points);

        // Partial update of the Display / Theme menu values
        void setDisplay(const nlohmann::json& display);

        // Source menu of one radio as a list of SmGui draw list elements. action may be null,
        // otherwise { id, type: "void"|"bool"|"int"|"float"|"string", value }.
        nlohmann::json getMenu(int radio, const nlohmann::json& action);

        // Interference detection: settings, per band status, active events and the latest ended ones
        nlohmann::json getInterference();
        // Partial update of { enabled, thresholdDb, noiseRiseDb, learnSeconds, adaptMinutes }
        void setInterference(const nlohmann::json& settings);
        // Learn the baseline of one band again, or of every band with -1
        void relearn(int band);
        void clearHistory();

        std::string resourcesDirectory();
    }
}
