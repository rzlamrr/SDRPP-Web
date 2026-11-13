#include "web.h"
#include "engine.h"
#include "http_server.h"
#include <core.h>
#include <gui/smgui.h>
#include <utils/flog.h>
#include <filesystem>

namespace web {
    namespace {
        // Radios supported by the web monitor
        bool isSupportedSource(const std::string& filename) {
            return filename.find("bladerf_source") != std::string::npos || filename.find("rtl_sdr_source") != std::string::npos;
        }

        void loadModule(const std::filesystem::path& file) {
            if (file.extension().generic_string() != SDRPP_MOD_EXTENTSION) { return; }
            if (!std::filesystem::is_regular_file(file)) { return; }
            if (!isSupportedSource(file.filename().string())) { return; }
            flog::info("Loading {0}", file.generic_string());
            core::moduleManager.loadModule(file.generic_string());
        }
    }

    int main() {
        flog::info("=====| WEB MONITOR MODE |=====");

        // Load config, same keys as the server mode
        core::configManager.acquire();
        std::string modulesDir = core::configManager.conf["modulesDirectory"];
        std::vector<std::string> modules = core::configManager.conf["modules"];
        core::configManager.release();
        modulesDir = std::filesystem::absolute(modulesDir).string();

        // Source menus are recorded as draw lists instead of being drawn with ImGui
        SmGui::init(true);

        flog::info("Loading modules");
        if (std::filesystem::is_directory(modulesDir)) {
            for (const auto& file : std::filesystem::directory_iterator(modulesDir)) {
                loadModule(file.path());
            }
        }
        else {
            flog::warn("Module directory {0} does not exist, not loading modules from directory", modulesDir);
        }
        for (auto const& apath : modules) {
            loadModule(std::filesystem::absolute(apath));
        }

        // The engine creates one module instance per radio itself
        engine::init();

        // Unlike the server mode, only listen on this machine by default: the server-mode default
        // of 0.0.0.0 is read as "not specified". Pass the address of a network interface to --addr
        // to reach the monitor from other machines.
        std::string host = (std::string)core::args["addr"];
        if (host == "0.0.0.0") { host = "127.0.0.1"; }
        int port = (int)core::args["port"];

        if (core::args["autostart"].b()) {
            try { engine::start(); }
            catch (const std::exception& e) { flog::error("Could not start: {0}", e.what()); }
        }

        int ret = runHttpServer(host, port);
        engine::shutdown();
        return ret;
    }
}
