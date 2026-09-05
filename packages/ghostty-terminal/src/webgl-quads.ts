export type QuadColor = readonly [number, number, number, number];
export const WHITE: QuadColor = [1, 1, 1, 1];

const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec4 rect;
layout(location=1) in vec4 uvRect;
layout(location=2) in vec4 tint;
uniform vec2 viewport;
out vec2 uv;
out vec4 color;
const vec2 corners[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
void main() {
  vec2 corner = corners[gl_VertexID];
  vec2 pixel = rect.xy + corner * rect.zw;
  gl_Position = vec4(pixel.x / viewport.x * 2.0 - 1.0, 1.0 - pixel.y / viewport.y * 2.0, 0, 1);
  uv = uvRect.xy + corner * uvRect.zw;
  color = tint;
}`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D source;
in vec2 uv;
in vec4 color;
out vec4 outputColor;
void main() {
  vec4 sampleColor = texture(source, uv);
  outputColor = sampleColor * vec4(color.rgb * color.a, color.a);
}`;

export class WebglQuads {
  readonly white: WebGLTexture;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly viewport: WebGLUniformLocation | null;
  private readonly data = new Float32Array(4096 * 12);
  private count = 0;
  private texture: WebGLTexture | null = null;
  drawCalls = 0;

  constructor(readonly gl: WebGL2RenderingContext) {
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let white: WebGLTexture | null = null;
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, VERTEX],
        [gl.FRAGMENT_SHADER, FRAGMENT],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('WebGL shader allocation failed');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(`WebGL shader compilation failed: ${gl.getShaderInfoLog(shader)}`);
        }
      }
      program = gl.createProgram();
      if (!program) throw new Error('WebGL program allocation failed');
      for (const shader of shaders) gl.attachShader(program, shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(program)}`);
      }
      buffer = gl.createBuffer();
      vao = gl.createVertexArray();
      if (!buffer || !vao) throw new Error('WebGL vertex allocation failed');
      this.program = program;
      this.buffer = buffer;
      this.vao = vao;
      this.viewport = gl.getUniformLocation(program, 'viewport');
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
      for (let index = 0; index < 3; index++) {
        gl.enableVertexAttribArray(index);
        gl.vertexAttribPointer(index, 4, gl.FLOAT, false, 48, index * 16);
        gl.vertexAttribDivisor(index, 1);
      }
      white = this.createTexture(1, 1, new Uint8Array([255, 255, 255, 255]));
      this.white = white;
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'source'), 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.checkError();
    } catch (error) {
      if (white) gl.deleteTexture(white);
      if (vao) gl.deleteVertexArray(vao);
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  createTexture(width: number, height: number, pixels: Uint8Array | null = null): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('WebGL texture allocation failed');
    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      this.checkError();
      return texture;
    } catch (error) {
      gl.deleteTexture(texture);
      throw error;
    }
  }

  begin(width: number, height: number, background: QuadColor): void {
    const gl = this.gl;
    this.count = 0;
    this.texture = null;
    this.drawCalls = 0;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(this.viewport, width, height);
    gl.clearColor(background[0], background[1], background[2], background[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  quad(
    x: number,
    y: number,
    width: number,
    height: number,
    color: QuadColor = WHITE,
    texture = this.white,
    u = 0,
    v = 0,
    uw = 1,
    vh = 1
  ): void {
    if (width <= 0 || height <= 0) return;
    if (texture !== this.texture || this.count === 4096) this.flush();
    this.texture = texture;
    this.data.set([x, y, width, height, u, v, uw, vh, ...color], this.count * 12);
    this.count++;
  }

  flush(): void {
    if (!this.count || !this.texture) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.count * 12));
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    this.count = 0;
    this.drawCalls++;
  }

  checkError(): void {
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR)
      throw new Error(`WebGL operation failed (0x${error.toString(16)})`);
  }

  dispose(): void {
    this.count = 0;
    this.gl.deleteTexture(this.white);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}
