const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const { test } = require('node:test');
const withCommunicationNotifications = require('./withCommunicationNotifications');

const expoRequire = createRequire(require.resolve('expo/config-plugins'));
const xcode = expoRequire('xcode');
const plist = expoRequire('@expo/plist').default;
const mobileRoot = path.dirname(require.resolve('../package.json'));
const unquote = (value) => String(value ?? '').replaceAll('"', '');
const entries = (section) => Object.entries(section).filter(([key]) => !key.endsWith('_comment'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calab-communication-plugin-'));
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

async function applyPlugin({ ios, projectPath }) {
  const project = xcode.project(path.join(projectPath, 'project.pbxproj'));
  project.parseSync();
  const config = withCommunicationNotifications({ name: 'Calab', slug: 'calab', ios: { bundleIdentifier: 'test.calab', entitlements: { 'aps-environment': 'development' } } });
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
    .filter(([, target]) => unquote(target.name) === 'CalabNotificationService');
  assert.equal(targets.length, 1, 'one extension target after repeated prebuild');
  const [, target] = targets[0];
  const phases = target.buildPhases
    .map(({ value }) => project.hash.project.objects.PBXSourcesBuildPhase[value]).filter(Boolean);
  assert.equal(phases.length, 1, 'one Sources phase on the extension');
  assert.equal(phases[0].files.length, 3, 'all Swift sources compiled once');
  const groups = entries(project.hash.project.objects.PBXGroup);
  const rootGroup = project.hash.project.objects.PBXGroup[project.getFirstProject().firstProject.mainGroup];
  for (const name of ['NotificationService.swift', 'CalabCommunication.swift', 'CalabCommunicationPayload.swift']) {
    const refs = entries(project.pbxFileReferenceSection())
      .filter(([, ref]) => unquote(ref.path) === `CalabNotificationService/${name}`);
    assert.equal(refs.length, 1, `${name}: one file reference`);
    const [fileId] = refs[0];
    const parents = groups.filter(([, group]) => group.children.some(({ value }) => value === fileId));
    assert.equal(parents.length, 1, `${name}: a parent group is required by xcodeproj/CocoaPods`);
    const [groupId, group] = parents[0];
    assert.ok(rootGroup.children.some(({ value }) => value === groupId), 'source group is in the project tree');
    assert.ok(fs.existsSync(path.join(ios, unquote(group.path), `CalabNotificationService/${name}`)), 'group-relative source path exists');
    const builds = entries(project.pbxBuildFileSection()).filter(([, build]) => build.fileRef === fileId);
    assert.equal(builds.length, 1, `${name}: one build file`);
    assert.equal(phases[0].files.filter(({ value }) => value === builds[0][0]).length, 1);
  }
  const products = entries(project.pbxFileReferenceSection())
    .filter(([, ref]) => unquote(ref.path) === 'CalabNotificationService.appex');
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

// Apple permits Communication Notifications on the containing app, not the NSE App ID.
// Requesting it on the extension makes automatic provisioning reject the signed build.
test('communication grant stays on app while NSE can use an ordinary profile', async (t) => {
  const config = withCommunicationNotifications({ name: 'Calab', slug: 'calab', ios: {
    bundleIdentifier: 'test.calab', entitlements: { 'aps-environment': 'development' },
  } });
  const result = await config.mods.ios.entitlements({
    ...config,
    modResults: { 'aps-environment': 'development' },
    modRequest: { projectRoot: mobileRoot, platform: 'ios', modName: 'entitlements' },
  });
  assert.equal(result.modResults['com.apple.developer.usernotifications.communication'], true);
  assert.equal(result.modResults['aps-environment'], 'development');
  const native = fixture(t);
  for (let run = 0; run < 2; run++) {
    await applyPlugin(native);
    const entitlements = plist.parse(fs.readFileSync(path.join(native.ios,
      'CalabNotificationService/CalabNotificationService.entitlements'), 'utf8'));
    assert.equal(entitlements['com.apple.developer.usernotifications.communication'], undefined,
      'notification service profile cannot carry the app-only communication grant');
  }
});
