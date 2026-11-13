#include "http_server.h"
#include "engine.h"
#include <crow.h>
#include <utils/flog.h>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <sstream>
#include <unordered_set>

using nlohmann::json;

namespace web {
    namespace {
        const char* contentType(const std::string& ext) {
            if (ext == ".html") { return "text/html; charset=utf-8"; }
            if (ext == ".js") { return "text/javascript; charset=utf-8"; }
            if (ext == ".css") { return "text/css; charset=utf-8"; }
            if (ext == ".json") { return "application/json"; }
            if (ext == ".png") { return "image/png"; }
            if (ext == ".ico") { return "image/x-icon"; }
            if (ext == ".svg") { return "image/svg+xml"; }
            if (ext == ".ttf") { return "font/ttf"; }
            return "application/octet-stream";
        }

        crow::response serveFile(const std::string& root, const std::string& rel) {
            // Only plain relative paths below root
            if (rel.find("..") != std::string::npos || rel.find(':') != std::string::npos || rel.find('\\') != std::string::npos ||
                (!rel.empty() && rel[0] == '/')) {
                return crow::response(400);
            }
            std::filesystem::path path = std::filesystem::path(root) / rel;
            std::ifstream file(path, std::ios::binary);
            if (!file || !std::filesystem::is_regular_file(path)) { return crow::response(404); }
            std::ostringstream body;
            body << file.rdbuf();
            crow::response res(body.str());
            res.set_header("Content-Type", contentType(path.extension().string()));
            res.set_header("Cache-Control", "no-cache");
            return res;
        }

        crow::response jsonResponse(const json& j, int code = 200) {
            crow::response res(code, j.dump());
            res.set_header("Content-Type", "application/json");
            return res;
        }

        // A page from another site must not be able to drive the radios through the operator's browser
        bool sameOrigin(const crow::request& req) {
            std::string origin = req.get_header_value("Origin");
            if (origin.empty()) { return true; }
            size_t pos = origin.find("://");
            std::string originHost = (pos == std::string::npos) ? origin : origin.substr(pos + 3);
            return originHost == req.get_header_value("Host");
        }

        // Runs an API call and turns exceptions into an error message for the operator
        template <typename F>
        crow::response api(const crow::request& req, F&& func) {
            if (!sameOrigin(req)) { return jsonResponse({ { "error", "Request from another origin was refused" } }, 403); }
            try {
                json body = req.body.empty() ? json() : json::parse(req.body);
                return jsonResponse(func(body));
            }
            catch (const std::exception& e) {
                return jsonResponse({ { "error", e.what() } }, 400);
            }
        }
    }

    int runHttpServer(const std::string& host, int port) {
        crow::SimpleApp app;
        app.loglevel(crow::LogLevel::Warning);

        std::string resDir = engine::resourcesDirectory();
        std::string webDir = resDir + "/web";
        if (!std::filesystem::is_regular_file(webDir + "/index.html")) {
            flog::warn("Web interface not found in {0}, build web/frontend first", webDir);
        }

        std::mutex clientsMtx;
        std::unordered_set<crow::websocket::connection*> clients;

        engine::setFrameHandler([&](const std::string& frame) {
            std::lock_guard<std::mutex> lck(clientsMtx);
            for (auto conn : clients) { conn->send_binary(frame); }
        });

        CROW_WEBSOCKET_ROUTE(app, "/ws")
            .onaccept([](const crow::request& req, void**) { return sameOrigin(req); })
            .onopen([&](crow::websocket::connection& conn) {
                std::lock_guard<std::mutex> lck(clientsMtx);
                clients.insert(&conn);
            })
            .onclose([&](crow::websocket::connection& conn, const std::string&, uint16_t) {
                std::lock_guard<std::mutex> lck(clientsMtx);
                clients.erase(&conn);
            })
            .onmessage([&](crow::websocket::connection&, const std::string& data, bool isBinary) {
                if (isBinary) { return; }
                try {
                    json msg = json::parse(data);
                    if (msg.value("type", "") == "view") {
                        engine::setView(msg.at("band").get<int>(), msg.at("offset").get<double>(), msg.at("bandwidth").get<double>(), msg.at("points").get<int>());
                    }
                }
                catch (const std::exception&) {}
            });

        CROW_ROUTE(app, "/api/state")
        ([](const crow::request& req) {
            return api(req, [](const json&) { return engine::getState(); });
        });

        CROW_ROUTE(app, "/api/start").methods(crow::HTTPMethod::Post)
        ([](const crow::request& req) {
            return api(req, [](const json&) { engine::start(); return engine::getState(); });
        });

        CROW_ROUTE(app, "/api/stop").methods(crow::HTTPMethod::Post)
        ([](const crow::request& req) {
            return api(req, [](const json&) { engine::stop(); return engine::getState(); });
        });

        CROW_ROUTE(app, "/api/setup").methods(crow::HTTPMethod::Put)
        ([](const crow::request& req) {
            return api(req, [](const json& body) { engine::setSetup(body); return engine::getState(); });
        });

        CROW_ROUTE(app, "/api/display").methods(crow::HTTPMethod::Put)
        ([](const crow::request& req) {
            return api(req, [](const json& body) { engine::setDisplay(body); return engine::getState(); });
        });

        CROW_ROUTE(app, "/api/bands").methods(crow::HTTPMethod::Post)
        ([](const crow::request& req) {
            return api(req, [](const json& body) { engine::addBand(body); return engine::getState(); });
        });

        CROW_ROUTE(app, "/api/bands/<int>").methods(crow::HTTPMethod::Put, crow::HTTPMethod::Delete)
        ([](const crow::request& req, int id) {
            return api(req, [&](const json& body) {
                if (req.method == crow::HTTPMethod::Delete) { engine::removeBand(id); }
                else { engine::updateBand(id, body); }
                return engine::getState();
            });
        });

        CROW_ROUTE(app, "/api/radios/<int>/menu").methods(crow::HTTPMethod::Get, crow::HTTPMethod::Post)
        ([](const crow::request& req, int radio) {
            return api(req, [&](const json& body) { return engine::getMenu(radio, body); });
        });

        CROW_ROUTE(app, "/api/interference").methods(crow::HTTPMethod::Get, crow::HTTPMethod::Put)
        ([](const crow::request& req) {
            return api(req, [&](const json& body) {
                if (req.method == crow::HTTPMethod::Put) { engine::setInterference(body); }
                return engine::getInterference();
            });
        });

        CROW_ROUTE(app, "/api/interference/learn").methods(crow::HTTPMethod::Post)
        ([](const crow::request& req) {
            return api(req, [](const json& body) {
                engine::relearn((body.is_object() && body.contains("band")) ? body["band"].get<int>() : -1);
                return engine::getInterference();
            });
        });

        CROW_ROUTE(app, "/api/interference/history").methods(crow::HTTPMethod::Delete)
        ([](const crow::request& req) {
            return api(req, [](const json&) { engine::clearHistory(); return engine::getInterference(); });
        });

        // SDR++ resources (color maps, themes, icons, fonts) and the web interface itself
        CROW_ROUTE(app, "/res/<path>")
        ([resDir](const std::string& path) { return serveFile(resDir, path); });

        CROW_ROUTE(app, "/")
        ([webDir]() { return serveFile(webDir, "index.html"); });

        CROW_ROUTE(app, "/<path>")
        ([webDir](const std::string& path) { return serveFile(webDir, path); });

        flog::info("Web monitor ready on http://{0}:{1}", host, port);
        app.bindaddr(host).port((uint16_t)port).multithreaded().run();

        engine::setFrameHandler(nullptr);
        return 0;
    }
}
