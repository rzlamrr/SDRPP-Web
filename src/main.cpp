#include <core.h>
#ifdef SDRPP_WEB_MONITOR
#include <web.h>
#endif

int main(int argc, char* argv[]) {
#ifdef SDRPP_WEB_MONITOR
    // Makes "sdrpp --web" available
    core::webEntry = web::main;
#endif
    return sdrpp_main(argc, argv);
}
