import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const deployment = args.length === 1 && args[0] === '--deployment';
// Never leave a previous deployment target in a local or rejected build.
rmSync('dist/.openai/hosting.json', { force: true });
if (args.length && !deployment) throw new Error('Use npm run build or npm run build:deployment.');
let hosting;
if (deployment) {
  try { hosting = JSON.parse(readFileSync('.openai/hosting.json', 'utf8')); }
  catch { throw new Error('Deployment packaging requires .openai/hosting.json. Copy the example and enter your own Sites project ID.'); }
  if (!hosting || typeof hosting !== 'object' || Array.isArray(hosting)
      || !/^appgprj_[a-f0-9]{32}$/.test(hosting.project_id || '')
      || hosting.d1 !== 'DB' || hosting.r2 !== 'BUCKET'
      || JSON.stringify(hosting.capabilities) !== '["mcp"]'
      || Object.keys(hosting).some(key => !['project_id', 'd1', 'r2', 'capabilities'].includes(key))) {
    throw new Error('Invalid hosting configuration: supply your own appgprj_ project ID, DB and BUCKET bindings, and only the mcp capability.');
  }
}
execFileSync(process.execPath, ['scripts/extract-core.mjs'], { stdio: 'inherit' });
writeFileSync('worker/brand.generated.mjs', '// Generated from assets/turnfeed-logo.png by scripts/build.mjs.\nexport const logoBase64 = ' + JSON.stringify(readFileSync('assets/turnfeed-logo.png').toString('base64')) + ';\n');
mkdirSync('dist/server', { recursive: true });
const result = await build({ entryPoints: ['worker/index.mjs'], outfile: 'dist/server/index.js', bundle: true,
  format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], inject: ['worker/globals.mjs'], minify: true, metafile: true });
if (deployment) {
  mkdirSync('dist/.openai', { recursive: true });
  writeFileSync('dist/.openai/hosting.json', JSON.stringify(hosting, null, 2) + '\n');
}
writeFileSync('dist/build-report.json', JSON.stringify({ bytes: readFileSync('dist/server/index.js').length,
  mode: deployment ? 'deployment' : 'local',
  runtimeImports: Object.values(result.metafile.outputs).flatMap(output => output.imports.map(i => i.path)) }, null, 2));
console.log(readFileSync('dist/build-report.json', 'utf8'));
