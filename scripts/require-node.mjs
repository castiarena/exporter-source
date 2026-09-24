/**
 * Preflight Node version check.
 *
 * The build toolchain (Vite 8 / rolldown, Vitest 5) uses APIs that only exist in
 * Node 22.12+ — `node:util`'s `styleText`, among others. On an older Node those
 * fail while the module graph is being *linked*, which happens before any code
 * in this project runs, so the user sees a raw
 *
 *   SyntaxError: The requested module 'node:util' does not provide an export
 *   named 'styleText'
 *
 * with nothing to connect it to their Node version. This module exists to say
 * so plainly instead.
 *
 * It must not import anything outside node: builtins, and any script that wants
 * its protection has to load the offending tooling with a dynamic `import()`
 * *after* this has run — a static import would be linked first and crash anyway.
 */
/**
 * The floor is the intersection of the toolchain's own engine ranges, not a
 * round number: Vite 8 wants >=22.12, Vitest 5 wants ^22.12, and ESLint 10 wants
 * ^22.13 — so 22.13 is the lowest version on which the whole set installs.
 * Keep this, `engines` in package.json and .nvmrc in step.
 */
const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 13;

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const tooOld = major < REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR);

if (tooOld) {
  process.stderr.write(
    [
      '',
      `  exporter needs Node ${REQUIRED_MAJOR}.${REQUIRED_MINOR} or newer — you are on ${process.version}.`,
      '',
      '  The build tooling (Vite 8, Vitest 5, ESLint 10) needs Node APIs that do',
      '  not exist in older releases. Below 22.12 the failure is an unhelpful',
      '  "does not provide an export named \'styleText\'"; on 22.12 exactly, npm',
      '  refuses to install ESLint, which requires 22.13.',
      '',
      '  If you use nvm, this repo has a .nvmrc:',
      '',
      '      nvm use',
      '',
      `  Otherwise install Node ${REQUIRED_MAJOR} from https://nodejs.org and re-run.`,
      '',
      '  After switching, reinstall so native tooling matches the new runtime:',
      '',
      '      npm ci',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
