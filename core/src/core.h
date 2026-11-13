#pragma once
#include <config.h>
#include <module.h>
#include <module_com.h>
#include "command_args.h"

namespace core {
    SDRPP_EXPORT ConfigManager configManager;
    SDRPP_EXPORT ModuleManager moduleManager;
    SDRPP_EXPORT ModuleComManager modComManager;
    SDRPP_EXPORT CommandArgsParser args;

    // Web monitor mode (--web). The executable sets webEntry before calling sdrpp_main.
    // webSampleRateHandler receives the sample rate reported by the source being configured.
    SDRPP_EXPORT int (*webEntry)();
    SDRPP_EXPORT void (*webSampleRateHandler)(double samplerate);

    void setInputSampleRate(double samplerate);
};

int sdrpp_main(int argc, char* argv[]);