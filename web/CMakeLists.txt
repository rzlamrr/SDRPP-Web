cmake_minimum_required(VERSION 3.14)
project(sdrpp_web)

# Multi-band web monitor: engine built on the SDR++ core plus an HTTP/WebSocket server.
# It is linked into the sdrpp executable and reached with "sdrpp --web".

include(FetchContent)
if (POLICY CMP0135)
    cmake_policy(SET CMP0135 NEW)
endif ()

# Header only libraries: a SOURCE_SUBDIR that does not exist downloads them without running their CMake
FetchContent_Declare(crow
    URL https://github.com/CrowCpp/Crow/archive/refs/tags/v1.3.4.tar.gz
    SOURCE_SUBDIR _none)
FetchContent_Declare(asio
    URL https://github.com/chriskohlhoff/asio/archive/refs/tags/asio-1-36-0.tar.gz
    SOURCE_SUBDIR _none)
FetchContent_MakeAvailable(crow asio)

file(GLOB WEB_SRC "src/*.cpp")
add_library(sdrpp_web STATIC ${WEB_SRC})

target_compile_options(sdrpp_web PRIVATE ${SDRPP_COMPILER_FLAGS})
target_include_directories(sdrpp_web PUBLIC "src/")
target_include_directories(sdrpp_web SYSTEM PRIVATE
    ${crow_SOURCE_DIR}/include
    ${asio_SOURCE_DIR}/asio/include)
target_compile_definitions(sdrpp_web PRIVATE ASIO_STANDALONE)
target_link_libraries(sdrpp_web PUBLIC sdrpp_core)

if (MSVC)
    target_compile_options(sdrpp_web PRIVATE /bigobj /utf-8)
    target_compile_definitions(sdrpp_web PRIVATE NOMINMAX _WIN32_WINNT=0x0A00)
    target_link_libraries(sdrpp_web PRIVATE ws2_32 mswsock)
else ()
    find_package(Threads REQUIRED)
    target_link_libraries(sdrpp_web PRIVATE Threads::Threads)
endif ()
