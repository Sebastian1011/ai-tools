import inventory from '../src/inventory.json' with { type: 'json' };
import { implementedTools } from '../src/tools.mjs';
import { selectedTools } from '../src/server.mjs';

const official = new Set(inventory.tools.map(tool => tool.name));
const missing = [...official].filter(name => !implementedTools.has(name));
const extras = [...implementedTools].filter(name => !official.has(name));
console.log(`Pinned upstream: ${inventory.commit}`);
console.log(`Official local tools: ${official.size}`);
console.log(`Implemented tools: ${implementedTools.size}`);
console.log(`Default before credential scope filtering: ${selectedTools({}).length}`);
console.log(`Missing: ${missing.join(', ') || 'none'}`);
console.log(`Extra: ${extras.join(', ') || 'none'}`);
if (missing.length || extras.length) process.exitCode = 1;
