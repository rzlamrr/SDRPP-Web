#pragma once
#include <string>

namespace web {
    // Serves the web interface, the REST API and the FFT WebSocket. Blocks until the server is stopped.
    int runHttpServer(const std::string& host, int port);
}
