cmake_minimum_required(VERSION 3.24)
project(rfengine LANGUAGES CXX)

# ReelForge native engine: multi-track video composition, GPU decode/encode and media analysis on FFmpeg.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(FFMPEG_ROOT "" CACHE PATH "FFmpeg shared build with include/, lib/ and bin/")
if(NOT FFMPEG_ROOT)
  message(FATAL_ERROR "Set FFMPEG_ROOT to an FFmpeg shared build (include, lib, bin).")
endif()

add_executable(rfengine src/main.cpp src/json.hpp)
target_include_directories(rfengine PRIVATE "${FFMPEG_ROOT}/include")
target_link_directories(rfengine PRIVATE "${FFMPEG_ROOT}/lib")
target_link_libraries(rfengine PRIVATE avfilter avformat avcodec avutil swscale swresample)
if(MINGW)
  # One self-contained exe apart from the FFmpeg DLLs.
  target_link_options(rfengine PRIVATE -static -municode)
endif()
if(MSVC)
  target_compile_options(rfengine PRIVATE /utf-8 /W3)
else()
  target_compile_options(rfengine PRIVATE -O2 -Wall)
endif()

# The FFmpeg DLLs sit next to the exe, so it runs from the build folder and from the app's resources.
file(GLOB FFMPEG_DLLS "${FFMPEG_ROOT}/bin/avcodec*.dll" "${FFMPEG_ROOT}/bin/avformat*.dll" "${FFMPEG_ROOT}/bin/avutil*.dll" "${FFMPEG_ROOT}/bin/avfilter*.dll" "${FFMPEG_ROOT}/bin/sw*.dll")
add_custom_command(TARGET rfengine POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different ${FFMPEG_DLLS} $<TARGET_FILE_DIR:rfengine>)
