const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const { test } = require('node:test');
const withSessionActivity = require('./withSessionActivity');

const expoRequire = createRequire(require.resolve('expo/config-plugins'));
const xcode = expoRequire('xcode');
const mobileRoot = path.dirname(require.resolve('../package.json'));
const unquote = (value) => String(value ?? '').replaceAll('"', '');
const entries = (section) => Object.entries(section).filter(([key]) => !key.endsWith('_comment'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calab-activity-plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ios = path.join(root, 'ios');
  const projectPath = path.join(ios, 'HelloWorld.xcodeproj');
  fs.mkdirSync(projectPath, { recursive: true });
  // Use Expo's installed native template, not a mock of its Xcode object graph.
  const template = path.join(path.dirname(require.resolve('expo/package.json')), 'template.tgz');
  fs.writeFileSync(path.join(projectPath, 'project.pbxproj'), execFileSync('tar', [
    '-xOf', template, 'package/ios/HelloWorld.xcodeproj/project.pbxproj',
  ]));
  return { ios, projectPath };
}

async function applyPlugin({ ios, projectPath }, version = '0.1.0', buildNumber = '1', bundleIdentifier = 'test.calab', calendar) {
  const project = xcode.project(path.join(projectPath, 'project.pbxproj'));
  project.parseSync();
  const config = withSessionActivity({ name: 'Calab', slug: 'calab', version, ios: { buildNumber, bundleIdentifier } }, { calendar });
  await config.mods.ios.xcodeproj({
    ...config,
    modResults: project,
    modRequest: { projectRoot: mobileRoot, platformProjectRoot: ios, platform: 'ios', modName: 'xcodeproj' },
  });
  fs.writeFileSync(path.join(projectPath, 'project.pbxproj'), project.writeSync());
  return project;
}

function assertExtensionGraph(project, ios) {
  const targets = entries(project.pbxNativeTargetSection())
    .filter(([, target]) => unquote(target.name) === 'CalabVoiceActivity');
  assert.equal(targets.length, 1, 'one extension target after repeated prebuild');
  const [, target] = targets[0];
  const phases = target.buildPhases
    .map(({ value }) => project.hash.project.objects.PBXSourcesBuildPhase[value]).filter(Boolean);
  assert.equal(phases.length, 1, 'one Sources phase on the extension');
  assert.equal(phases[0].files.length, 2, 'both Swift sources compiled once');
  const groups = entries(project.hash.project.objects.PBXGroup);
  const rootGroup = project.hash.project.objects.PBXGroup[project.getFirstProject().firstProject.mainGroup];
  for (const name of ['CalabVoiceActivity.swift', 'CalabVoiceAttributes.swift']) {
    const refs = entries(project.pbxFileReferenceSection())
      .filter(([, ref]) => unquote(ref.path) === `CalabVoiceActivity/${name}`);
    assert.equal(refs.length, 1, `${name}: one file reference`);
    const [fileId] = refs[0];
    const parents = groups.filter(([, group]) => group.children.some(({ value }) => value === fileId));
    assert.equal(parents.length, 1, `${name}: a parent group is required by xcodeproj/CocoaPods`);
    const [groupId, group] = parents[0];
    assert.ok(rootGroup.children.some(({ value }) => value === groupId), 'source group is in the project tree');
    assert.ok(fs.existsSync(path.join(ios, unquote(group.path), `CalabVoiceActivity/${name}`)), 'group-relative source path exists');
    const builds = entries(project.pbxBuildFileSection()).filter(([, build]) => build.fileRef === fileId);
    assert.equal(builds.length, 1, `${name}: one build file`);
    assert.equal(phases[0].files.filter(({ value }) => value === builds[0][0]).length, 1);
  }
  const products = entries(project.pbxFileReferenceSection())
    .filter(([, ref]) => unquote(ref.path) === 'CalabVoiceActivity.appex');
  assert.equal(products.length, 1, 'one extension product');
  assert.equal(target.productReference, products[0][0]);
  const embedFiles = entries(project.pbxBuildFileSection()).filter(([, file]) => file.fileRef === products[0][0]);
  assert.equal(embedFiles.length, 1, 'one embed build file');
  const copyPhases = entries(project.hash.project.objects.PBXCopyFilesBuildPhase);
  assert.equal(copyPhases.flatMap(([, phase]) => phase.files).filter(({ value }) => value === embedFiles[0][0]).length, 1);
}

test('extension sources have real parent groups and survive repeated plugin runs', async (t) => {
  const native = fixture(t);
  for (let run = 0; run < 3; run++) assertExtensionGraph(await applyPlugin(native), native.ios);
});

test('CocoaPods xcodeproj serialization keeps one extension on the next prebuild', async (t) => {
  const ruby = [process.env.CALAB_XCODEPROJ_RUBY, '/opt/homebrew/opt/ruby/bin/ruby', 'ruby']
    .filter(Boolean).find((candidate) => spawnSync(candidate, ['-e', 'require "xcodeproj"']).status === 0);
  if (!ruby) return t.skip('Ruby xcodeproj is unavailable; Node Xcode graph regression still runs');
  const native = fixture(t);
  for (let run = 0; run < 3; run++) {
    await applyPlugin(native);
    execFileSync(ruby, ['-rxcodeproj', '-e', 'Xcodeproj::Project.open(ARGV[0]).save', native.projectPath]);
    const project = xcode.project(path.join(native.projectPath, 'project.pbxproj'));
    project.parseSync();
    assertExtensionGraph(project, native.ios);
  }
});

// A subsequent release must update an existing target, not keep the old build identity.
test('extension identity follows changed app configuration across prebuilds', async (t) => {
  const native = fixture(t);
  for (const [version, buildNumber] of [['0.1.0', '21'], ['4.2.3', '22'], ['4.2.3', '22']]) {
    const bundleIdentifier = `test.calab.build${buildNumber}`;
    const project = await applyPlugin(native, version, buildNumber, bundleIdentifier);
    const [, target] = entries(project.pbxNativeTargetSection()).find(([, value]) => unquote(value.name) === 'CalabVoiceActivity');
    const list = project.hash.project.objects.XCConfigurationList[target.buildConfigurationList];
    for (const { value } of list.buildConfigurations) {
      const settings = project.pbxXCBuildConfigurationSection()[value].buildSettings;
      assert.equal(unquote(settings.PRODUCT_BUNDLE_IDENTIFIER), `${bundleIdentifier}.voiceactivity`);
      assert.equal(unquote(settings.MARKETING_VERSION), version);
      assert.equal(unquote(settings.CURRENT_PROJECT_VERSION), buildNumber);
    }
  }
});


test('calendar extension is opted in with shared groups and survives enabling on an existing target', async (t) => {
  const native = fixture(t);
  await applyPlugin(native);
  for (let i = 0; i < 2; i++) {
    const project = await applyPlugin(native, '0.1.0', '22', 'test.calab', { group: 'group.test.calab', origin: 'https://calab.example.com', scheme: 'calab-test' });
    const [, target] = entries(project.pbxNativeTargetSection()).find(([, value]) => unquote(value.name) === 'CalabVoiceActivity');
    const list = project.hash.project.objects.XCConfigurationList[target.buildConfigurationList];
    for (const { value } of list.buildConfigurations) {
      const settings = project.pbxXCBuildConfigurationSection()[value].buildSettings;
      assert.match(unquote(settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS), /CALAB_CALENDAR_WIDGETS/);
      assert.ok(fs.existsSync(path.join(native.ios, unquote(settings.CODE_SIGN_ENTITLEMENTS))));
    }
    const sources = target.buildPhases.map(({ value }) => project.hash.project.objects.PBXSourcesBuildPhase[value]).filter(Boolean)[0];
    assert.equal(sources.files.length, 6, 'all shared/widget sources, no duplicates');
    const info = fs.readFileSync(path.join(native.ios, 'CalabVoiceActivity/CalabVoiceActivity-Info.plist'), 'utf8');
    assert.match(info, /https:\/\/calab.example.com/);
  }
});

test('host retains its private default Keychain group across repeated calendar opt-in', async (t) => {
  const native = fixture(t);
  const calendar = { group: 'group.test.calab', origin: 'https://calab.example.com', scheme: 'calab-test' };
  for (const previous of [[], ['$(AppIdentifierPrefix)test.calab.calendar']]) {
    const config = withSessionActivity({ name: 'Calab', slug: 'calab', ios: { bundleIdentifier: 'test.calab' } }, { calendar });
    const result = await config.mods.ios.entitlements({
      ...config, modResults: { 'keychain-access-groups': previous },
      modRequest: { projectRoot: mobileRoot, platformProjectRoot: native.ios, platform: 'ios', modName: 'entitlements' },
    });
    assert.deepEqual(result.modResults['keychain-access-groups'], ['$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)', '$(AppIdentifierPrefix)test.calab.calendar']);
  }
});
