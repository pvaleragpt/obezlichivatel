/* Обезличиватель — чтение и запись ZIP (docx и xlsx — это ZIP-архивы) потоком.
 *
 * Без библиотек: распаковка и упаковка — встроенными в браузер
 * DecompressionStream / CompressionStream ('deflate-raw'). Файл целиком в память
 * не читается: записи берутся кусками через Blob.slice, а неизменённые записи
 * копируются в новый архив как есть, без пересжатия.
 */
var Zip = (function () {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(crc, bytes) {
    crc = ~crc;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return ~crc >>> 0;
  }

  async function bytesOf(blob, start, end) { return new Uint8Array(await blob.slice(start, end).arrayBuffer()); }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 4294967296; }

  // Оглавление архива.
  async function readEntries(blob) {
    var size = blob.size, tailLen = Math.min(size, 65557);
    var tail = await bytesOf(blob, size - tailLen, size), eocd = -1;
    for (var i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Это не похоже на файл Word или Excel: не найдено оглавление архива. Возможно, файл повреждён или защищён паролем.');
    var count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
    if (cdOff === 0xFFFFFFFF || count === 0xFFFF) {     // ZIP64
      var loc = eocd - 20;
      if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
        var z64off = u64(tail, loc + 8);
        var rec = await bytesOf(blob, z64off, z64off + 56);
        count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48);
      }
    }
    var cd = await bytesOf(blob, cdOff, cdOff + cdSize), p = 0, out = [];
    var dec = new TextDecoder('utf-8');
    for (var e = 0; e < count; e++) {
      if (u32(cd, p) !== 0x02014b50) throw new Error('Повреждено оглавление архива.');
      var flags = u16(cd, p + 8), method = u16(cd, p + 10), time = u16(cd, p + 12), date = u16(cd, p + 14);
      var crc = u32(cd, p + 16), csize = u32(cd, p + 20), usize = u32(cd, p + 24);
      var nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32), off = u32(cd, p + 42);
      var name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
      var x = p + 46 + nlen, xend = x + xlen;
      while (x + 4 <= xend) {            // ZIP64 extra: настоящие размеры и смещение
        var id = u16(cd, x), len = u16(cd, x + 2), q = x + 4;
        if (id === 1) {
          if (usize === 0xFFFFFFFF) { usize = u64(cd, q); q += 8; }
          if (csize === 0xFFFFFFFF) { csize = u64(cd, q); q += 8; }
          if (off === 0xFFFFFFFF) { off = u64(cd, q); q += 8; }
        }
        x += 4 + len;
      }
      out.push({ name: name, flags: flags, method: method, time: time, date: date, crc: crc,
                 csize: csize, usize: usize, offset: off });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  async function dataStart(blob, e) {
    if (e._data != null) return e._data;
    var h = await bytesOf(blob, e.offset, e.offset + 30);
    if (u32(h, 0) !== 0x04034b50) throw new Error('Повреждена запись архива ' + e.name);
    e._data = e.offset + 30 + u16(h, 26) + u16(h, 28);
    return e._data;
  }

  // Поток распакованных байтов записи.
  async function entryStream(blob, e) {
    if (e.flags & 1) throw new Error('Файл защищён паролем. Снимите защиту и попробуйте снова.');
    var start = await dataStart(blob, e);
    var raw = blob.slice(start, start + e.csize).stream();
    if (e.method === 0) return raw;
    if (e.method === 8) return raw.pipeThrough(new DecompressionStream('deflate-raw'));
    throw new Error('Неподдерживаемое сжатие в записи ' + e.name);
  }

  // Текст записи целиком (для небольших частей: оглавления, связи, свойства).
  async function entryText(blob, e) {
    var s = await entryStream(blob, e);
    return await new Response(s).text();
  }

  // Текст записи кусками, разрезанными по границе (например, '</row>'),
  // чтобы ни один элемент не оказался разрезан. onChunk(text) может быть async.
  async function eachChunk(blob, e, boundary, onChunk, onProgress, chunkChars) {
    chunkChars = chunkChars || 4 * 1024 * 1024;
    var reader = (await entryStream(blob, e)).getReader();
    var dec = new TextDecoder('utf-8'), buf = '', done = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      done += r.value.length;
      buf += dec.decode(r.value, { stream: true });
      if (buf.length >= chunkChars) {
        var cut = buf.lastIndexOf(boundary);
        if (cut >= 0) {
          cut += boundary.length;
          await onChunk(buf.slice(0, cut));
          buf = buf.slice(cut);
        }
        if (onProgress) onProgress(done, e.usize);
      }
    }
    buf += dec.decode();
    if (buf) await onChunk(buf);
    if (onProgress) onProgress(e.usize, e.usize);
  }

  function dosTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  // Проверка результата: всё, что пишется в новый архив (и копируется из старого как XML), можно посмотреть.
  var inspector = null;
  function setInspector(fn) { inspector = fn; }
  function inspect(name, text) { if (inspector && text) inspector(name, text); }

  // Новый архив. Части копятся в Blob — браузер сам выгружает большие на диск.
  function Writer() {
    this.parts = []; this.pending = []; this.pendingBytes = 0;
    this.offset = 0; this.central = []; this.enc = new TextEncoder();
    this.now = dosTime(new Date());
  }
  Writer.prototype._push = function (chunk) {
    var len = chunk.size != null ? chunk.size : chunk.length;
    this.pending.push(chunk); this.pendingBytes += len; this.offset += len;
    if (this.pendingBytes > 32 * 1024 * 1024) this._flush();
  };
  Writer.prototype._flush = function () {
    if (this.pending.length) { this.parts.push(new Blob(this.pending)); this.pending = []; this.pendingBytes = 0; }
  };
  Writer.prototype._local = function (nameBytes, flags, method, time, date, crc, csize, usize) {
    var h = new Uint8Array(30 + nameBytes.length), v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, flags, true);
    v.setUint16(8, method, true); v.setUint16(10, time, true); v.setUint16(12, date, true);
    v.setUint32(14, crc, true); v.setUint32(18, csize, true); v.setUint32(22, usize, true);
    v.setUint16(26, nameBytes.length, true); v.setUint16(28, 0, true);
    h.set(nameBytes, 30);
    return h;
  };
  Writer.prototype._check = function (n) {
    if (n >= 0xFFFFFFFF || this.offset >= 0xFFFFFFFF) throw new Error('Результат больше 4 ГБ — такой размер пока не поддерживается.');
  };

  // Скопировать запись из исходного архива без изменений.
  Writer.prototype.copy = async function (blob, e) {
    if (inspector && /\.(?:xml|rels)$/i.test(e.name) && e.usize < 50 * 1024 * 1024) inspect(e.name, await entryText(blob, e));
    var start = await dataStart(blob, e), nameBytes = this.enc.encode(e.name), at = this.offset;
    this._check(e.csize);
    var flags = (e.flags & ~8) | 0x800;
    this._push(this._local(nameBytes, flags, e.method, e.time, e.date, e.crc, e.csize, e.usize));
    var part = blob.slice(start, start + e.csize);
    this._push(part.u8 || part);           // MemBlob из воркера отдаёт байты, обычный Blob — себя
    this.central.push({ nameBytes: nameBytes, flags: flags, method: e.method, time: e.time, date: e.date,
                        crc: e.crc, csize: e.csize, usize: e.usize, offset: at });
  };

  // Открыть новую запись, в которую пишут текст кусками. Возвращает { write(text), close() }.
  Writer.prototype.open = function (name) {
    var self = this, nameBytes = this.enc.encode(name), at = this.offset, flags = 0x808;
    this._push(this._local(nameBytes, flags, 8, this.now.time, this.now.date, 0, 0, 0));
    var cs = new CompressionStream('deflate-raw'), w = cs.writable.getWriter(), rd = cs.readable.getReader();
    var crc = 0, usize = 0, csize = 0;
    var pump = (async function () {
      for (;;) { var r = await rd.read(); if (r.done) break; csize += r.value.length; self._push(r.value); }
    })();
    return {
      write: async function (text) {
        if (!text) return;
        inspect(name, text);
        var b = self.enc.encode(text); crc = crc32(crc, b); usize += b.length;
        await w.ready; await w.write(b);
      },
      close: async function () {
        await w.close(); await pump;
        self._check(usize); self._check(csize);
        var d = new Uint8Array(16), v = new DataView(d.buffer);
        v.setUint32(0, 0x08074b50, true); v.setUint32(4, crc, true); v.setUint32(8, csize, true); v.setUint32(12, usize, true);
        self._push(d);
        self.central.push({ nameBytes: nameBytes, flags: flags, method: 8, time: self.now.time, date: self.now.date,
                            crc: crc, csize: csize, usize: usize, offset: at });
      }
    };
  };

  Writer.prototype.addText = async function (name, text) {
    var e = this.open(name); await e.write(text); await e.close();
  };

  Writer.prototype.finish = function (mime) {
    var cdStart = this.offset, cdLen = 0, self = this;
    this.central.forEach(function (c) {
      var h = new Uint8Array(46 + c.nameBytes.length), v = new DataView(h.buffer);
      v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true);
      v.setUint16(8, c.flags, true); v.setUint16(10, c.method, true); v.setUint16(12, c.time, true);
      v.setUint16(14, c.date, true); v.setUint32(16, c.crc, true); v.setUint32(20, c.csize, true);
      v.setUint32(24, c.usize, true); v.setUint16(28, c.nameBytes.length, true);
      v.setUint32(42, c.offset, true); h.set(c.nameBytes, 46);
      self._push(h); cdLen += h.length;
    });
    var end = new Uint8Array(22), v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, this.central.length, true);
    v.setUint16(10, this.central.length, true); v.setUint32(12, cdLen, true); v.setUint32(16, cdStart, true);
    this._push(end); this._flush();
    return new Blob(this.parts, { type: mime || 'application/zip' });
  };

  return { readEntries: readEntries, entryStream: entryStream, entryText: entryText, eachChunk: eachChunk,
           Writer: Writer, crc32: crc32, setInspector: setInspector, inspect: inspect };
})();
