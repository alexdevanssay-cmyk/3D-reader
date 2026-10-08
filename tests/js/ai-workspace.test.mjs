import test from "node:test";
import assert from "node:assert/strict";
import { addressSpace } from "../../web/ai-workspace.js";

test("Ollama's address declares the address space the browser checks it against", () => {
  // This computer.
  for (const url of ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"]) assert.equal(addressSpace(url), "loopback", url);
  // Another device of the local network, a Jetson for instance.
  for (const url of ["http://192.168.1.50:11434", "http://10.0.0.7:11434", "http://172.20.1.1:11434", "http://jetson.local:11434", "http://jetson:11434", "http://[fd12:3456::1]:11434"]) {
    assert.equal(addressSpace(url), "local", url);
  }
  // Public addresses: nothing declared.
  for (const url of ["https://api.example.com", "http://203.0.113.5:11434", "http://172.32.1.1:11434"]) assert.equal(addressSpace(url), undefined, url);
});
