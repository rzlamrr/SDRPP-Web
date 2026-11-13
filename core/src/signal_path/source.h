#pragma once
#include <string>
#include <vector>
#include <map>
#include <dsp/stream.h>
#include <dsp/types.h>
#include <utils/event.h>

class SourceManager {
public:
    SourceManager();

    struct SourceHandler {
        dsp::stream<dsp::complex_t>* stream;
        void (*menuHandler)(void* ctx);
        void (*selectHandler)(void* ctx);
        void (*deselectHandler)(void* ctx);
        void (*startHandler)(void* ctx);
        void (*stopHandler)(void* ctx);
        void (*tuneHandler)(double freq, void* ctx);
        void* ctx;

        // Optional device management, used by the web monitor to give each radio its own device.
        // Modules that do not set them are treated as always having their device.
        // Ids of the connected devices this process can open now (an open device may be left out). Does not change the selection.
        std::vector<std::string> (*listDevicesHandler)(void* ctx) = NULL;
        // Selects a device by id, false if it is not connected. Only called while stopped.
        bool (*selectDeviceHandler)(std::string id, void* ctx) = NULL;
        // Id of the selected device, empty if none
        std::string (*selectedDeviceHandler)(void* ctx) = NULL;
    };

    enum TuningMode {
        NORMAL,
        PANADAPTER
    };

    void registerSource(std::string name, SourceHandler* handler);
    void unregisterSource(std::string name);
    void selectSource(std::string name);
    void showSelectedMenu();
    void start();
    void stop();
    void tune(double freq);
    void setTuningOffset(double offset);
    void setTuningMode(TuningMode mode);
    void setPanadapterIF(double freq);

    std::vector<std::string> getSourceNames();

    // Direct access to a registered source, used by the web monitor to run several sources at once
    SourceHandler* getHandler(std::string name);

    Event<std::string> onSourceRegistered;
    Event<std::string> onSourceUnregister;
    Event<std::string> onSourceUnregistered;
    Event<double> onRetune;

private:
    std::map<std::string, SourceHandler*> sources;
    std::string selectedName;
    SourceHandler* selectedHandler = NULL;
    double tuneOffset;
    double currentFreq;
    double ifFreq = 0.0;
    TuningMode tuneMode = TuningMode::NORMAL;
    dsp::stream<dsp::complex_t> nullSource;
};