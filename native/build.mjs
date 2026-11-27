// Builds the native engine: node native/build.mjs. Uses the portable toolchain in %LOCALAPPDATA%\ReelForgeDev
// (llvm-mingw clang, FFmpeg shared dev build) and CMake/Ninja from pip, unless RF_FFMPEG_ROOT / PATH say otherwise.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dev = path.join(process.env.LOCALAPPDATA || '', 'ReelForgeDev');
const pick = (prefix) => (fs.existsSync(dev) ? fs.readdirSync(dev).filter((d) => d.startsWith(prefix)).map((d) => path.join(dev, d))[0] : undefined);
const ffmpeg = process.env.RF_FFMPEG_ROOT || pick('ffmpeg-');
const llvm = pick('llvm-mingw-');
if (!ffmpeg) throw new Error('FFmpeg shared dev build not found. Set RF_FFMPEG_ROOT.');
const py = (code) => execFileSync('python', ['-c', code], { encoding: 'utf8' }).trim();
const extra = [llvm && path.join(llvm, 'bin'), py('import cmake;print(cmake.CMAKE_BIN_DIR)'), path.dirname(py('import ninja,os;print(os.path.join(ninja.BIN_DIR,"ninja"))'))].filter(Boolean);
const env = { ...process.env, PATH: [...extra, process.env.PATH].join(path.delimiter) };
const src = path.join(import.meta.dirname, 'engine');
const out = path.join(src, 'build');
const run = (args) => execFileSync('cmake', args, { stdio: 'inherit', env });
run(['-S', src, '-B', out, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', ...(llvm ? ['-DCMAKE_CXX_COMPILER=clang++'] : []), `-DFFMPEG_ROOT=${ffmpeg}`]);
run(['--build', out]);
console.log('engine built:', path.join(out, 'rfengine.exe'));
