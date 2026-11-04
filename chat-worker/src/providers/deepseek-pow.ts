import { DEEPSEEK_POW_WASM_BASE64 } from './deepseek-wasm.js';

export interface DeepSeekPowConfig {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
  target_path: string;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  wasm_solve: (
    retptr: number,
    challengePtr: number,
    challengeLen: number,
    prefixPtr: number,
    prefixLen: number,
    difficulty: number
  ) => void;
  __wbindgen_add_to_stack_pointer: (offset: number) => number;
  __wbindgen_export_0: (length: number, align: number) => number;
}

let instancePromise: Promise<WebAssembly.Instance> | null = null;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function getInstance(): Promise<WebAssembly.Instance> {
  instancePromise ??= (
    WebAssembly.instantiate(decodeBase64(DEEPSEEK_POW_WASM_BASE64), {}) as unknown as Promise<{
      instance: WebAssembly.Instance;
    }>
  ).then((result) => result.instance);
  return instancePromise;
}

/**
 * DeepSeekHashV1（SHA3-256 难度搜索）求解。
 *
 * WASM 是 dsapi 仓库里的 sha3_wasm_bg.wasm，26KB，算法与官方一致；
 * 纯 JS SHA3 的迭代顺序与 WASM 不同，不能直接替换。
 */
export async function solveDeepSeekPow(config: DeepSeekPowConfig): Promise<string> {
  const instance = await getInstance();
  const exports = instance.exports as unknown as WasmExports;
  const memory = exports.memory;

  const writeString = (value: string): { ptr: number; length: number } => {
    const bytes = new TextEncoder().encode(value);
    const ptr = exports.__wbindgen_export_0(bytes.length, 1);
    // 分配可能触发 memory.grow，必须重新读 buffer。
    new Uint8Array(memory.buffer).set(bytes, ptr);
    return { ptr, length: bytes.length };
  };

  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const challenge = writeString(config.challenge);
    const prefix = writeString(`${config.salt}_${config.expire_at}_`);

    exports.wasm_solve(
      retptr,
      challenge.ptr,
      challenge.length,
      prefix.ptr,
      prefix.length,
      config.difficulty
    );

    const status = new Int32Array(memory.buffer)[retptr / 4];
    if (status === 0) throw new Error('DeepSeek PoW solver returned no solution');

    const value = new Float64Array(memory.buffer)[(retptr + 8) / 8];
    const answer = Math.floor(value);

    return encodeBase64(
      JSON.stringify({
        algorithm: config.algorithm,
        challenge: config.challenge,
        salt: config.salt,
        answer,
        signature: config.signature,
        target_path: config.target_path,
      })
    );
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}
