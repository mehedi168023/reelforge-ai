// rfengine: ReelForge's native media engine (C++20 on FFmpeg).
//
//   rfengine probe <file>                 length, size and streams of a media file
//   rfengine waveform <file> <points>     loudness peaks for drawing a sound on the timeline
//   rfengine compose <job.json>           flattens video clips on tracks (trims, layers, picture-in-picture)
//                                         and their sound into one MP4, decoding on the GPU (D3D11VA) and
//                                         encoding with NVENC, Quick Sync or AMF when the PC has one
//
// Replies are JSON, one object per line on stdout: {"progress":0.42} while working, then {"ok":true,...} or
// {"error":"..."}.

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/display.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

#include "json.hpp"

namespace {

// ---------- small helpers ----------
std::string errstr(int code) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {};
  av_strerror(code, buf, sizeof buf);
  return buf;
}

void check(int code, const std::string& what) {
  if (code < 0) throw std::runtime_error(what + ": " + errstr(code));
}

void reply(const std::string& line) {
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

struct FormatCloser {
  void operator()(AVFormatContext* f) const { avformat_close_input(&f); }
};
struct CodecFree {
  void operator()(AVCodecContext* c) const { avcodec_free_context(&c); }
};
struct FrameFree {
  void operator()(AVFrame* f) const { av_frame_free(&f); }
};
struct PacketFree {
  void operator()(AVPacket* p) const { av_packet_free(&p); }
};
struct SwsFree {
  void operator()(SwsContext* s) const { sws_freeContext(s); }
};
struct SwrFree {
  void operator()(SwrContext* s) const { swr_free(&s); }
};
using FormatPtr = std::unique_ptr<AVFormatContext, FormatCloser>;
using CodecPtr = std::unique_ptr<AVCodecContext, CodecFree>;
using FramePtr = std::unique_ptr<AVFrame, FrameFree>;
using PacketPtr = std::unique_ptr<AVPacket, PacketFree>;
using SwrPtr = std::unique_ptr<SwrContext, SwrFree>;

FramePtr newFrame() { return FramePtr(av_frame_alloc()); }
PacketPtr newPacket() { return PacketPtr(av_packet_alloc()); }

FormatPtr openInput(const std::string& path) {
  AVFormatContext* f = nullptr;
  check(avformat_open_input(&f, path.c_str(), nullptr, nullptr), "Can't open " + path);
  FormatPtr out(f);
  check(avformat_find_stream_info(f, nullptr), "Can't read " + path);
  return out;
}

double streamSeconds(AVFormatContext* f, int index) {
  AVStream* s = f->streams[index];
  if (s->duration > 0) return s->duration * av_q2d(s->time_base);
  if (f->duration > 0) return f->duration / double(AV_TIME_BASE);
  return 0;
}

/** Clockwise rotation (0, 90, 180, 270) the file asks players to apply. */
int rotationOf(AVStream* s) {
  const AVPacketSideData* sd = av_packet_side_data_get(s->codecpar->coded_side_data, s->codecpar->nb_coded_side_data, AV_PKT_DATA_DISPLAYMATRIX);
  if (!sd || sd->size < 9 * 4) return 0;
  double r = -av_display_rotation_get(reinterpret_cast<const int32_t*>(sd->data));
  int deg = (static_cast<int>(std::lround(r / 90.0)) * 90 % 360 + 360) % 360;
  return deg;
}

// ---------- GPU decode ----------
AVBufferRef* g_hwDevice = nullptr;
bool g_hwTried = false;

AVBufferRef* hwDevice() {
  if (!g_hwTried) {
    g_hwTried = true;
#ifdef _WIN32
    if (av_hwdevice_ctx_create(&g_hwDevice, AV_HWDEVICE_TYPE_D3D11VA, nullptr, nullptr, 0) < 0) g_hwDevice = nullptr;
#endif
  }
  return g_hwDevice;
}

enum AVPixelFormat pickFormat(AVCodecContext*, const enum AVPixelFormat* fmts) {
  for (const enum AVPixelFormat* p = fmts; *p != AV_PIX_FMT_NONE; p++)
    if (*p == AV_PIX_FMT_D3D11) return *p;
  // No GPU path for this stream: the first software format.
  for (const enum AVPixelFormat* p = fmts; *p != AV_PIX_FMT_NONE; p++) {
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(*p);
    if (d && !(d->flags & AV_PIX_FMT_FLAG_HWACCEL)) return *p;
  }
  return fmts[0];
}

CodecPtr openDecoder(AVStream* s, bool allowGpu) {
  const AVCodec* dec = avcodec_find_decoder(s->codecpar->codec_id);
  if (!dec) throw std::runtime_error("No decoder for this stream.");
  CodecPtr c(avcodec_alloc_context3(dec));
  check(avcodec_parameters_to_context(c.get(), s->codecpar), "Decoder setup");
  c->pkt_timebase = s->time_base;
  c->thread_count = 0;
  if (allowGpu && s->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && hwDevice()) {
    c->hw_device_ctx = av_buffer_ref(hwDevice());
    c->get_format = pickFormat;
  }
  check(avcodec_open2(c.get(), dec, nullptr), "Can't open the decoder");
  return c;
}

// ---------- probe ----------
int cmdProbe(const std::string& path) {
  FormatPtr f = openInput(path);
  int v = av_find_best_stream(f.get(), AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
  int a = av_find_best_stream(f.get(), AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  double duration = f->duration > 0 ? f->duration / double(AV_TIME_BASE) : 0;
  std::ostringstream o;
  o << "{\"ok\":true,\"duration\":" << json::num(duration);
  if (v >= 0) {
    AVStream* s = f->streams[v];
    int rot = rotationOf(s);
    int w = s->codecpar->width, h = s->codecpar->height;
    if (rot == 90 || rot == 270) std::swap(w, h);
    AVRational fr = av_guess_frame_rate(f.get(), s, nullptr);
    o << ",\"width\":" << w << ",\"height\":" << h << ",\"fps\":" << json::num(fr.den ? av_q2d(fr) : 0) << ",\"codec\":" << json::quote(avcodec_get_name(s->codecpar->codec_id)) << ",\"rotation\":" << rot;
  } else {
    o << ",\"width\":0,\"height\":0";
  }
  o << ",\"hasAudio\":" << (a >= 0 ? "true" : "false") << "}";
  reply(o.str());
  return 0;
}

// ---------- sound ----------
/** Decodes a file's sound to 48 kHz stereo float, from `from` seconds for `len` seconds (len < 0: to the end). */
std::vector<float> decodeAudio(const std::string& path, double from, double len) {
  std::vector<float> out;
  FormatPtr f = openInput(path);
  int ai = av_find_best_stream(f.get(), AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  if (ai < 0) return out;
  AVStream* s = f->streams[ai];
  CodecPtr dec = openDecoder(s, false);
  AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
  SwrContext* raw = nullptr;
  check(swr_alloc_set_opts2(&raw, &stereo, AV_SAMPLE_FMT_FLT, 48000, &dec->ch_layout, dec->sample_fmt, dec->sample_rate, 0, nullptr), "Resampler");
  SwrPtr swr(raw);
  check(swr_init(swr.get()), "Resampler");
  if (from > 0.05) av_seek_frame(f.get(), ai, static_cast<int64_t>(from / av_q2d(s->time_base)), AVSEEK_FLAG_BACKWARD);
  const int64_t wantStart = static_cast<int64_t>(std::llround(from * 48000));
  const int64_t wantEnd = len < 0 ? INT64_MAX : wantStart + static_cast<int64_t>(std::llround(len * 48000));
  int64_t cursor = -1;  // sample position (48 kHz) of the next converted sample
  PacketPtr pkt = newPacket();
  FramePtr frame = newFrame();
  std::vector<float> buf;
  auto take = [&](AVFrame* fr) {
    if (cursor < 0) {
      double t = fr && fr->best_effort_timestamp != AV_NOPTS_VALUE ? fr->best_effort_timestamp * av_q2d(s->time_base) : 0;
      cursor = static_cast<int64_t>(std::llround(t * 48000));
    }
    int cap = swr_get_out_samples(swr.get(), fr ? fr->nb_samples : 0) + 32;
    buf.resize(static_cast<size_t>(cap) * 2);
    uint8_t* dst = reinterpret_cast<uint8_t*>(buf.data());
    int n = swr_convert(swr.get(), &dst, cap, fr ? const_cast<const uint8_t**>(fr->extended_data) : nullptr, fr ? fr->nb_samples : 0);
    for (int i = 0; i < n; i++, cursor++) {
      if (cursor < wantStart || cursor >= wantEnd) continue;
      out.push_back(buf[2 * i]);
      out.push_back(buf[2 * i + 1]);
    }
  };
  while (cursor < wantEnd && av_read_frame(f.get(), pkt.get()) >= 0) {
    if (pkt->stream_index == ai && avcodec_send_packet(dec.get(), pkt.get()) >= 0) {
      while (avcodec_receive_frame(dec.get(), frame.get()) >= 0) take(frame.get());
    }
    av_packet_unref(pkt.get());
  }
  avcodec_send_packet(dec.get(), nullptr);
  while (avcodec_receive_frame(dec.get(), frame.get()) >= 0) take(frame.get());
  take(nullptr);
  return out;
}

int cmdWaveform(const std::string& path, int points) {
  std::vector<float> s = decodeAudio(path, 0, -1);
  points = std::clamp(points, 8, 20000);
  size_t frames = s.size() / 2;
  std::ostringstream o;
  o << "{\"ok\":true,\"seconds\":" << json::num(frames / 48000.0) << ",\"peaks\":[";
  for (int p = 0; p < points; p++) {
    size_t a = frames * p / points, b = std::max(a + 1, frames * (p + 1) / points);
    float peak = 0;
    for (size_t i = a; i < b && i < frames; i++) peak = std::max({peak, std::fabs(s[2 * i]), std::fabs(s[2 * i + 1])});
    o << (p ? "," : "") << json::num(std::min(1.0f, peak));
  }
  o << "]}";
  reply(o.str());
  return 0;
}

// ---------- compose ----------
struct ClipJob {
  std::string path;
  int track = 0;
  double start = 0, in = 0, out = -1, volume = 1, x = 0.5, y = 0.5, scale = 1;
};

/** Reads one clip's video forward in time, keeping the frame for the asked moment as BGRA in display orientation. */
class ClipReader {
 public:
  ClipJob job;
  double length = 0;  // source seconds this clip shows

  explicit ClipReader(const ClipJob& j) : job(j) {
    fmt_ = openInput(job.path);
    vi_ = av_find_best_stream(fmt_.get(), AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (vi_ < 0) throw std::runtime_error(job.path + " has no video.");
    stream_ = fmt_->streams[vi_];
    rotation_ = rotationOf(stream_);
    double total = streamSeconds(fmt_.get(), vi_);
    double out = job.out > 0 ? std::min(job.out, total > 0 ? total : job.out) : total;
    length = std::max(0.0, out - job.in);
    try {
      dec_ = openDecoder(stream_, true);
    } catch (...) {
      dec_ = openDecoder(stream_, false);
    }
    pkt_ = newPacket();
    raw_ = newFrame();
    next_ = newFrame();
    sw_ = newFrame();
  }

  bool activeAt(double t) const { return t >= job.start - 1e-6 && t < job.start + length - 1e-6; }

  /** The BGRA picture (display orientation) for timeline time t, or nullptr if the clip has no frame there. */
  const std::vector<uint8_t>* frameAt(double t, int& w, int& h) {
    double target = job.in + (t - job.start);
    if (!started_ || target < lastPts_ - 0.25) seekTo(target);
    // Decode until the next frame would be later than the target.
    while (!eof_ && (!have_ || nextPts_ <= target + 1e-4)) {
      if (!decodeOne()) break;
    }
    // Only the frame that will be shown is converted; frames skipped on the way are not.
    if (dirty_) {
      toImage(raw_.get());
      dirty_ = false;
    }
    if (!haveImage_) return nullptr;
    w = imgW_;
    h = imgH_;
    return &img_;
  }

 private:
  FormatPtr fmt_;
  int vi_ = -1;
  AVStream* stream_ = nullptr;
  CodecPtr dec_;
  PacketPtr pkt_;
  FramePtr raw_, next_, sw_;
  bool dirty_ = false;
  int rotation_ = 0;
  bool started_ = false, eof_ = false, have_ = false, haveImage_ = false, flushed_ = false;
  double lastPts_ = 0, nextPts_ = -1;
  std::vector<uint8_t> img_, tmp_;
  int imgW_ = 0, imgH_ = 0;
  SwsContext* sws_ = nullptr;

  void seekTo(double target) {
    av_seek_frame(fmt_.get(), vi_, static_cast<int64_t>(std::max(0.0, target - 0.05) / av_q2d(stream_->time_base)), AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(dec_.get());
    started_ = true;
    eof_ = flushed_ = have_ = false;
    nextPts_ = -1;
  }

  /** Receives the next decoded frame into raw_ (the previous one stays if there is none). Returns false at the end. */
  bool receive() {
    for (;;) {
      int r = avcodec_receive_frame(dec_.get(), next_.get());
      if (r >= 0) {
        av_frame_unref(raw_.get());
        av_frame_move_ref(raw_.get(), next_.get());
        return true;
      }
      if (r == AVERROR_EOF) return false;
      if (flushed_) return false;
      // Needs more input.
      for (;;) {
        int rr = av_read_frame(fmt_.get(), pkt_.get());
        if (rr < 0) {
          avcodec_send_packet(dec_.get(), nullptr);
          flushed_ = true;
          break;
        }
        bool mine = pkt_->stream_index == vi_;
        if (mine) avcodec_send_packet(dec_.get(), pkt_.get());
        av_packet_unref(pkt_.get());
        if (mine) break;
      }
    }
  }

  bool decodeOne() {
    if (!receive()) {
      eof_ = true;
      return false;
    }
    double pts = raw_->best_effort_timestamp != AV_NOPTS_VALUE ? raw_->best_effort_timestamp * av_q2d(stream_->time_base) : lastPts_ + 1.0 / 30;
    // Keep this frame as the current picture; nextPts_ is where the decoder now stands.
    lastPts_ = pts;
    nextPts_ = pts;
    have_ = true;
    dirty_ = true;
    // Peek: the following frame's time decides whether to keep going, so step once more lazily.
    nextPts_ = pts + frameStep();
    return true;
  }

  double frameStep() const {
    AVRational fr = av_guess_frame_rate(fmt_.get(), stream_, nullptr);
    return fr.num > 0 ? av_q2d(av_inv_q(fr)) : 1.0 / 30;
  }

  void toImage(AVFrame* f) {
    AVFrame* src = f;
    if (f->format == AV_PIX_FMT_D3D11) {
      av_frame_unref(sw_.get());
      check(av_hwframe_transfer_data(sw_.get(), f, 0), "GPU frame copy");
      src = sw_.get();
    }
    int w = src->width, h = src->height;
    sws_ = sws_getCachedContext(sws_, w, h, static_cast<AVPixelFormat>(src->format), w, h, AV_PIX_FMT_BGRA, SWS_BILINEAR, nullptr, nullptr, nullptr);
    if (!sws_) throw std::runtime_error("Can't convert this video's pixels.");
    tmp_.resize(static_cast<size_t>(w) * h * 4);
    uint8_t* dst[4] = {tmp_.data(), nullptr, nullptr, nullptr};
    int ls[4] = {w * 4, 0, 0, 0};
    sws_scale(sws_, src->data, src->linesize, 0, h, dst, ls);
    rotate(w, h);
    haveImage_ = true;
  }

  void rotate(int w, int h) {
    if (rotation_ == 0) {
      img_.swap(tmp_);
      imgW_ = w;
      imgH_ = h;
      return;
    }
    bool swap = rotation_ == 90 || rotation_ == 270;
    imgW_ = swap ? h : w;
    imgH_ = swap ? w : h;
    img_.resize(tmp_.size());
    const uint32_t* s = reinterpret_cast<const uint32_t*>(tmp_.data());
    uint32_t* d = reinterpret_cast<uint32_t*>(img_.data());
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++) {
        int dx, dy;
        if (rotation_ == 90) dx = h - 1 - y, dy = x;
        else if (rotation_ == 180) dx = w - 1 - x, dy = h - 1 - y;
        else dx = y, dy = w - 1 - x;
        d[static_cast<size_t>(dy) * imgW_ + dx] = s[static_cast<size_t>(y) * w + x];
      }
  }

 public:
  ~ClipReader() {
    if (sws_) sws_freeContext(sws_);
  }
};

/** Crops a picture to fill a w x h box (cover) and scales it into the canvas at (x, y). */
class Blitter {
 public:
  ~Blitter() {
    if (sws_) sws_freeContext(sws_);
  }
  void cover(const std::vector<uint8_t>& src, int sw, int sh, uint8_t* canvas, int cw, int ch, int x, int y, int w, int h) {
    if (w <= 0 || h <= 0) return;
    double k = std::max(double(w) / sw, double(h) / sh);
    int cropW = std::clamp(static_cast<int>(std::lround(w / k)), 1, sw);
    int cropH = std::clamp(static_cast<int>(std::lround(h / k)), 1, sh);
    int cx = (sw - cropW) / 2, cy = (sh - cropH) / 2;
    sws_ = sws_getCachedContext(sws_, cropW, cropH, AV_PIX_FMT_BGRA, w, h, AV_PIX_FMT_BGRA, SWS_BICUBIC, nullptr, nullptr, nullptr);
    if (!sws_) throw std::runtime_error("Can't scale a clip.");
    const uint8_t* s[4] = {src.data() + (static_cast<size_t>(cy) * sw + cx) * 4, nullptr, nullptr, nullptr};
    int sls[4] = {sw * 4, 0, 0, 0};
    buf_.resize(static_cast<size_t>(w) * h * 4);
    uint8_t* d[4] = {buf_.data(), nullptr, nullptr, nullptr};
    int dls[4] = {w * 4, 0, 0, 0};
    sws_scale(sws_, s, sls, 0, cropH, d, dls);
    for (int row = 0; row < h; row++) {
      int ty = y + row;
      if (ty < 0 || ty >= ch) continue;
      int x0 = std::max(0, x), x1 = std::min(cw, x + w);
      if (x1 <= x0) continue;
      std::memcpy(canvas + (static_cast<size_t>(ty) * cw + x0) * 4, buf_.data() + (static_cast<size_t>(row) * w + (x0 - x)) * 4, static_cast<size_t>(x1 - x0) * 4);
    }
  }

 private:
  SwsContext* sws_ = nullptr;
  std::vector<uint8_t> buf_;
};

struct Encoder {
  const AVCodec* codec = nullptr;
  CodecPtr ctx;
  std::string name;
};

/** The fastest H.264 encoder that opens on this PC: NVIDIA, Intel, AMD, then x264 on the CPU. */
Encoder openVideoEncoder(int w, int h, int fps, bool globalHeader) {
  // Trying an encoder the PC lacks logs an error; that's expected here, so keep it quiet.
  struct Quiet {
    int level = av_log_get_level();
    Quiet() { av_log_set_level(AV_LOG_QUIET); }
    ~Quiet() { av_log_set_level(level); }
  } quiet;
  const char* names[] = {"h264_nvenc", "h264_qsv", "h264_amf", "libx264"};
  for (const char* n : names) {
    const AVCodec* c = avcodec_find_encoder_by_name(n);
    if (!c) continue;
    CodecPtr ctx(avcodec_alloc_context3(c));
    ctx->width = w;
    ctx->height = h;
    ctx->time_base = AVRational{1, fps};
    ctx->framerate = AVRational{fps, 1};
    ctx->gop_size = fps * 2;
    ctx->max_b_frames = 0;
    ctx->pix_fmt = std::string(n) == "h264_qsv" ? AV_PIX_FMT_NV12 : AV_PIX_FMT_YUV420P;
    if (globalHeader) ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    AVDictionary* o = nullptr;
    std::string sn = n;
    if (sn == "h264_nvenc") {
      av_dict_set(&o, "preset", "p5", 0);
      av_dict_set(&o, "rc", "vbr", 0);
      av_dict_set(&o, "cq", "17", 0);
    } else if (sn == "h264_qsv") {
      av_dict_set(&o, "preset", "medium", 0);
      av_dict_set(&o, "global_quality", "18", 0);
    } else if (sn == "h264_amf") {
      av_dict_set(&o, "quality", "quality", 0);
      av_dict_set(&o, "rc", "cqp", 0);
      av_dict_set(&o, "qp_i", "17", 0);
      av_dict_set(&o, "qp_p", "19", 0);
    } else {
      av_dict_set(&o, "preset", "veryfast", 0);
      av_dict_set(&o, "crf", "16", 0);
    }
    int r = avcodec_open2(ctx.get(), c, &o);
    av_dict_free(&o);
    if (r >= 0) return Encoder{c, std::move(ctx), sn};
  }
  throw std::runtime_error("No H.264 encoder could be opened.");
}

int cmdCompose(const std::string& jobPath) {
  std::ifstream in(jobPath, std::ios::binary);
  if (!in) throw std::runtime_error("Can't read the job file.");
  std::stringstream ss;
  ss << in.rdbuf();
  json::Value job = json::parse(ss.str());
  const int W = static_cast<int>(job["width"].num()) & ~1, H = static_cast<int>(job["height"].num()) & ~1;
  const int fps = std::clamp(static_cast<int>(std::lround(job["fps"].num(30))), 10, 60);
  const double duration = job["duration"].num();
  const std::string outPath = job["out"].str();
  if (W < 16 || H < 16 || duration <= 0 || outPath.empty()) throw std::runtime_error("The job needs width, height, duration and out.");

  std::vector<std::unique_ptr<ClipReader>> clips;
  for (const json::Value& c : job["clips"].arr()) {
    ClipJob j;
    j.path = c["path"].str();
    j.track = static_cast<int>(c["track"].num());
    j.start = c["start"].num();
    j.in = c["in"].num();
    j.out = c["out"].isNull() ? -1 : c["out"].num(-1);
    j.volume = c["volume"].num(1);
    j.x = c["x"].num(0.5);
    j.y = c["y"].num(0.5);
    j.scale = std::clamp(c["scale"].num(1), 0.05, 1.0);
    clips.push_back(std::make_unique<ClipReader>(j));
  }
  // Lower tracks first, so higher tracks draw over them.
  std::stable_sort(clips.begin(), clips.end(), [](auto& a, auto& b) { return a->job.track < b->job.track; });

  // Sound: each clip's own audio, trimmed and placed, mixed at 48 kHz stereo.
  const int64_t totalSamples = static_cast<int64_t>(std::llround(duration * 48000));
  std::vector<float> mix(static_cast<size_t>(totalSamples) * 2, 0.0f);
  bool anySound = false;
  for (auto& c : clips) {
    if (c->job.volume <= 0.001 || c->length <= 0) continue;
    std::vector<float> a = decodeAudio(c->job.path, c->job.in, c->length);
    if (a.empty()) continue;
    anySound = true;
    int64_t at = static_cast<int64_t>(std::llround(c->job.start * 48000));
    for (size_t i = 0; i + 1 < a.size(); i += 2) {
      int64_t s = at + static_cast<int64_t>(i / 2);
      if (s < 0 || s >= totalSamples) continue;
      mix[2 * s] += a[i] * static_cast<float>(c->job.volume);
      mix[2 * s + 1] += a[i + 1] * static_cast<float>(c->job.volume);
    }
  }
  float peak = 0;
  for (float v : mix) peak = std::max(peak, std::fabs(v));
  if (peak > 0.98f)
    for (float& v : mix) v *= 0.98f / peak;

  // Output file.
  AVFormatContext* oc = nullptr;
  check(avformat_alloc_output_context2(&oc, nullptr, "mp4", outPath.c_str()), "Output");
  std::unique_ptr<AVFormatContext, void (*)(AVFormatContext*)> ocGuard(oc, [](AVFormatContext* f) {
    if (f && !(f->oformat->flags & AVFMT_NOFILE)) avio_closep(&f->pb);
    avformat_free_context(f);
  });
  bool globalHeader = oc->oformat->flags & AVFMT_GLOBALHEADER;
  Encoder venc = openVideoEncoder(W, H, fps, globalHeader);
  AVStream* vs = avformat_new_stream(oc, nullptr);
  check(avcodec_parameters_from_context(vs->codecpar, venc.ctx.get()), "Video stream");
  vs->time_base = venc.ctx->time_base;

  CodecPtr aenc;
  AVStream* as = nullptr;
  if (anySound) {
    const AVCodec* ac = avcodec_find_encoder(AV_CODEC_ID_AAC);
    aenc.reset(avcodec_alloc_context3(ac));
    aenc->sample_rate = 48000;
    aenc->sample_fmt = AV_SAMPLE_FMT_FLTP;
    AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
    av_channel_layout_copy(&aenc->ch_layout, &stereo);
    aenc->bit_rate = 192000;
    aenc->time_base = AVRational{1, 48000};
    if (globalHeader) aenc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    check(avcodec_open2(aenc.get(), ac, nullptr), "AAC encoder");
    as = avformat_new_stream(oc, nullptr);
    check(avcodec_parameters_from_context(as->codecpar, aenc.get()), "Audio stream");
    as->time_base = aenc->time_base;
  }
  check(avio_open(&oc->pb, outPath.c_str(), AVIO_FLAG_WRITE), "Can't write " + outPath);
  check(avformat_write_header(oc, nullptr), "Output header");

  PacketPtr pkt = newPacket();
  auto drain = [&](AVCodecContext* enc, AVStream* st) {
    while (avcodec_receive_packet(enc, pkt.get()) >= 0) {
      av_packet_rescale_ts(pkt.get(), enc->time_base, st->time_base);
      pkt->stream_index = st->index;
      check(av_interleaved_write_frame(oc, pkt.get()), "Write");
    }
  };

  // Audio is fed in step with video, so the muxer never holds much.
  int64_t audioPos = 0;
  FramePtr af = newFrame();
  auto feedAudioUntil = [&](int64_t untilSample, bool flush) {
    if (!aenc) return;
    const int n = aenc->frame_size > 0 ? aenc->frame_size : 1024;
    while (audioPos < std::min(untilSample, totalSamples)) {
      int count = static_cast<int>(std::min<int64_t>(n, totalSamples - audioPos));
      av_frame_unref(af.get());
      af->nb_samples = n;
      af->format = AV_SAMPLE_FMT_FLTP;
      af->sample_rate = 48000;
      AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
      av_channel_layout_copy(&af->ch_layout, &stereo);
      check(av_frame_get_buffer(af.get(), 0), "Audio frame");
      float* l = reinterpret_cast<float*>(af->data[0]);
      float* r = reinterpret_cast<float*>(af->data[1]);
      for (int i = 0; i < n; i++) {
        bool in = i < count;
        l[i] = in ? mix[2 * (audioPos + i)] : 0;
        r[i] = in ? mix[2 * (audioPos + i) + 1] : 0;
      }
      af->pts = audioPos;
      check(avcodec_send_frame(aenc.get(), af.get()), "Encode audio");
      drain(aenc.get(), as);
      audioPos += n;
    }
    if (flush) {
      avcodec_send_frame(aenc.get(), nullptr);
      drain(aenc.get(), as);
    }
  };

  // Video: compose each frame in BGRA, then convert for the encoder.
  std::vector<uint8_t> canvas(static_cast<size_t>(W) * H * 4);
  std::vector<Blitter> blit(clips.size());
  SwsContext* toEnc = sws_getContext(W, H, AV_PIX_FMT_BGRA, W, H, venc.ctx->pix_fmt, SWS_BICUBIC, nullptr, nullptr, nullptr);
  if (!toEnc) throw std::runtime_error("Can't prepare frames for the encoder.");
  FramePtr vf = newFrame();
  vf->format = venc.ctx->pix_fmt;
  vf->width = W;
  vf->height = H;
  check(av_frame_get_buffer(vf.get(), 0), "Video frame");
  const int64_t total = static_cast<int64_t>(std::llround(duration * fps));
  auto last = std::chrono::steady_clock::now();
  for (int64_t i = 0; i < total; i++) {
    double t = double(i) / fps;
    std::fill(canvas.begin(), canvas.end(), 0);
    for (size_t k = 3; k < canvas.size(); k += 4) canvas[k] = 255;
    for (size_t c = 0; c < clips.size(); c++) {
      ClipReader& cr = *clips[c];
      if (!cr.activeAt(t)) continue;
      int sw = 0, sh = 0;
      const std::vector<uint8_t>* img = cr.frameAt(t, sw, sh);
      if (!img) continue;
      const ClipJob& j = cr.job;
      int w = static_cast<int>(std::lround(W * j.scale)), h = static_cast<int>(std::lround(H * j.scale));
      int x = j.scale < 1 ? static_cast<int>(std::lround(j.x * W - w / 2.0)) : 0;
      int y = j.scale < 1 ? static_cast<int>(std::lround(j.y * H - h / 2.0)) : 0;
      blit[c].cover(*img, sw, sh, canvas.data(), W, H, x, y, w, h);
    }
    check(av_frame_make_writable(vf.get()), "Video frame");
    const uint8_t* src[4] = {canvas.data(), nullptr, nullptr, nullptr};
    int sls[4] = {W * 4, 0, 0, 0};
    sws_scale(toEnc, src, sls, 0, H, vf->data, vf->linesize);
    vf->pts = i;
    feedAudioUntil(static_cast<int64_t>(std::llround((t + 1.0 / fps) * 48000)), false);
    check(avcodec_send_frame(venc.ctx.get(), vf.get()), "Encode video");
    drain(venc.ctx.get(), vs);
    auto now = std::chrono::steady_clock::now();
    if (now - last > std::chrono::milliseconds(250)) {
      last = now;
      reply("{\"progress\":" + json::num(double(i + 1) / total) + "}");
    }
  }
  sws_freeContext(toEnc);
  avcodec_send_frame(venc.ctx.get(), nullptr);
  drain(venc.ctx.get(), vs);
  feedAudioUntil(totalSamples, true);
  check(av_write_trailer(oc), "Finish file");
  reply("{\"ok\":true,\"out\":" + json::quote(outPath) + ",\"encoder\":" + json::quote(venc.name) + ",\"gpuDecode\":" + (g_hwDevice ? "true" : "false") + ",\"frames\":" + std::to_string(total) + "}");
  return 0;
}

#ifdef _WIN32
std::string utf8(const wchar_t* w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}
#endif

int run(const std::vector<std::string>& args) {
  av_log_set_level(AV_LOG_ERROR);
  if (args.size() < 2) {
    reply("{\"error\":\"usage: rfengine probe|waveform|compose ...\"}");
    return 2;
  }
  const std::string& cmd = args[1];
  try {
    if (cmd == "version") {
      reply("{\"ok\":true,\"engine\":\"rfengine 1.0\",\"ffmpeg\":" + json::quote(av_version_info()) + "}");
      return 0;
    }
    if (cmd == "probe" && args.size() >= 3) return cmdProbe(args[2]);
    if (cmd == "waveform" && args.size() >= 4) return cmdWaveform(args[2], std::stoi(args[3]));
    if (cmd == "compose" && args.size() >= 3) return cmdCompose(args[2]);
    reply("{\"error\":\"unknown command\"}");
    return 2;
  } catch (const std::exception& e) {
    reply("{\"error\":" + json::quote(e.what()) + "}");
    return 1;
  }
}

}  // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
  std::vector<std::string> args;
  for (int i = 0; i < argc; i++) args.push_back(utf8(argv[i]));
  int code = run(args);
  if (g_hwDevice) av_buffer_unref(&g_hwDevice);
  return code;
}
#else
int main(int argc, char** argv) {
  std::vector<std::string> args(argv, argv + argc);
  int code = run(args);
  if (g_hwDevice) av_buffer_unref(&g_hwDevice);
  return code;
}
#endif
