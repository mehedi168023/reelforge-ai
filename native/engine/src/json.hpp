// A small JSON reader and writer: enough for the engine's job files and its line-by-line replies.
#pragma once
#include <cctype>
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace json {

struct Value;
using Object = std::map<std::string, Value>;
using Array = std::vector<Value>;

struct Value {
  std::variant<std::nullptr_t, bool, double, std::string, std::shared_ptr<Array>, std::shared_ptr<Object>> v = nullptr;

  bool isNull() const { return std::holds_alternative<std::nullptr_t>(v); }
  bool isNum() const { return std::holds_alternative<double>(v); }
  bool isStr() const { return std::holds_alternative<std::string>(v); }
  bool isArr() const { return std::holds_alternative<std::shared_ptr<Array>>(v); }
  bool isObj() const { return std::holds_alternative<std::shared_ptr<Object>>(v); }

  double num(double fallback = 0) const { return isNum() ? std::get<double>(v) : fallback; }
  std::string str(const std::string& fallback = "") const { return isStr() ? std::get<std::string>(v) : fallback; }
  const Array& arr() const {
    static const Array empty;
    return isArr() ? *std::get<std::shared_ptr<Array>>(v) : empty;
  }
  const Value& operator[](const std::string& key) const {
    static const Value none;
    if (!isObj()) return none;
    const auto& o = *std::get<std::shared_ptr<Object>>(v);
    auto it = o.find(key);
    return it == o.end() ? none : it->second;
  }
};

class Parser {
 public:
  explicit Parser(const std::string& s) : s_(s) {}
  Value parse() {
    Value v = value();
    ws();
    if (i_ != s_.size()) fail("trailing text");
    return v;
  }

 private:
  const std::string& s_;
  size_t i_ = 0;

  [[noreturn]] void fail(const char* what) { throw std::runtime_error(std::string("bad JSON: ") + what); }
  void ws() {
    while (i_ < s_.size() && std::isspace(static_cast<unsigned char>(s_[i_]))) i_++;
  }
  bool eat(char c) {
    ws();
    if (i_ < s_.size() && s_[i_] == c) {
      i_++;
      return true;
    }
    return false;
  }
  Value value() {
    ws();
    if (i_ >= s_.size()) fail("unexpected end");
    char c = s_[i_];
    Value out;
    if (c == '{') {
      i_++;
      auto o = std::make_shared<Object>();
      if (!eat('}')) {
        do {
          ws();
          std::string k = string();
          if (!eat(':')) fail("expected :");
          (*o)[k] = value();
        } while (eat(','));
        if (!eat('}')) fail("expected }");
      }
      out.v = o;
    } else if (c == '[') {
      i_++;
      auto a = std::make_shared<Array>();
      if (!eat(']')) {
        do a->push_back(value());
        while (eat(','));
        if (!eat(']')) fail("expected ]");
      }
      out.v = a;
    } else if (c == '"') {
      out.v = string();
    } else if (s_.compare(i_, 4, "true") == 0) {
      i_ += 4;
      out.v = true;
    } else if (s_.compare(i_, 5, "false") == 0) {
      i_ += 5;
      out.v = false;
    } else if (s_.compare(i_, 4, "null") == 0) {
      i_ += 4;
    } else {
      size_t used = 0;
      double d = std::stod(s_.substr(i_, 40), &used);
      if (!used) fail("bad number");
      i_ += used;
      out.v = d;
    }
    return out;
  }
  static void utf8(std::string& out, unsigned cp) {
    if (cp < 0x80) out += static_cast<char>(cp);
    else if (cp < 0x800) {
      out += static_cast<char>(0xC0 | (cp >> 6));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += static_cast<char>(0xE0 | (cp >> 12));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (cp >> 18));
      out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    }
  }
  unsigned hex4() {
    if (i_ + 4 > s_.size()) fail("bad escape");
    unsigned v = std::stoul(s_.substr(i_, 4), nullptr, 16);
    i_ += 4;
    return v;
  }
  std::string string() {
    if (i_ >= s_.size() || s_[i_] != '"') fail("expected string");
    i_++;
    std::string out;
    while (i_ < s_.size() && s_[i_] != '"') {
      char c = s_[i_++];
      if (c != '\\') {
        out += c;
        continue;
      }
      if (i_ >= s_.size()) fail("bad escape");
      char e = s_[i_++];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
          unsigned cp = hex4();
          if (cp >= 0xD800 && cp < 0xDC00 && i_ + 6 <= s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
            i_ += 2;
            unsigned lo = hex4();
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(out, cp);
          break;
        }
        default: out += e;
      }
    }
    if (i_ >= s_.size()) fail("unterminated string");
    i_++;
    return out;
  }
};

inline Value parse(const std::string& s) { return Parser(s).parse(); }

inline std::string quote(const std::string& s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    if (c == '"') out += "\\\"";
    else if (c == '\\') out += "\\\\";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else if (c < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof buf, "\\u%04x", c);
      out += buf;
    } else out += static_cast<char>(c);
  }
  return out + "\"";
}

inline std::string num(double d) {
  if (!std::isfinite(d)) return "0";
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.6g", d);
  return buf;
}

}  // namespace json
