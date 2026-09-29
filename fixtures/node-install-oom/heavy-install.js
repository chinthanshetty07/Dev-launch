// An install step that needs about 1.4 GB — the shape of a large workspace install, which
// is what `horusyeung/nextjs-nestjs-fullstack-starter` ran out of memory on. Buffers live
// outside V8's heap, so this is a *container* limit, never a Node heap one: at 1024 MB the
// kernel kills it, and at 2048 MB it finishes.
const MB = 1024 * 1024;
const held = [];
for (let i = 0; i < 1400 / 50; i++) held.push(Buffer.alloc(50 * MB, 1));
console.log(`install step held ${held.length * 50} MB and finished`);
