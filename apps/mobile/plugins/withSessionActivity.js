// ActivityKit plus opt-in calendar WidgetKit surfaces (ADR-0146).
const fs = require('node:fs');
const path = require('node:path');
const { withInfoPlist, withXcodeProject, withEntitlementsPlist } = require('expo/config-plugins');

const TARGET = 'CalabVoiceActivity';

module.exports = (config, options = {}) => {
  if (!config.ios?.bundleIdentifier) return config;
  const calendar = options.calendar;
  const keychain = `$(AppIdentifierPrefix)${config.ios.bundleIdentifier}.calendar`;
  const info = calendar ? {
    CalabCalendarAppGroup: calendar.group, CalabCalendarOrigin: calendar.origin,
    CalabCalendarScheme: calendar.scheme, CalabCalendarKeychainGroup: keychain,
  } : {};
  if (calendar) config = withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.security.application-groups'] = [...new Set([...(mod.modResults['com.apple.security.application-groups'] ?? []), calendar.group])];
    const groups = (mod.modResults['keychain-access-groups'] ?? []).filter(group => group !== keychain);
    if (!groups.length) groups.push('$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)');
    mod.modResults['keychain-access-groups'] = [...new Set([...groups, keychain])];
    return mod;
  });
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSSupportsLiveActivities = true;
    mod.modResults.CalabSessionActivityEnabled = true;
    Object.assign(mod.modResults, info);
    return mod;
  });
  return withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const root = mod.modRequest.platformProjectRoot;
    const destination = path.join(root, TARGET);
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(path.join(mod.modRequest.projectRoot, 'widgets/CalabVoiceActivity.swift'), path.join(destination, 'CalabVoiceActivity.swift'));
    fs.copyFileSync(path.join(mod.modRequest.projectRoot, 'modules/calab-session-activity/ios/CalabVoiceAttributes.swift'), path.join(destination, 'CalabVoiceAttributes.swift'));
    const calendarSources = ['CalabCalendarModel.swift', 'CalabCalendarDisk.swift', 'CalabCalendarStore.swift', 'CalabCalendarWidgets.swift'];
    if (calendar) for (const name of calendarSources) {
      const source = name === 'CalabCalendarWidgets.swift' ? 'widgets' : 'modules/calab-session-activity/ios';
      fs.copyFileSync(path.join(mod.modRequest.projectRoot, source, name), path.join(destination, name));
    }
    const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    fs.writeFileSync(path.join(destination, `${TARGET}.entitlements`), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${calendar ? `<key>com.apple.security.application-groups</key><array><string>${xml(calendar.group)}</string></array><key>keychain-access-groups</key><array><string>${xml(keychain)}</string></array>` : ''}</dict></plist>`);
    fs.writeFileSync(path.join(destination, `${TARGET}-Info.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Calab</string>
<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
<key>CFBundlePackageType</key><string>XPC!</string>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string></dict>
${Object.entries(info).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('\n')}
</dict></plist>\n`);
    // CocoaPods/xcodeproj removes unnecessary quotes when it saves the project.
    const existing = Object.entries(project.pbxNativeTargetSection()).find(([key, value]) => !key.endsWith('_comment') && String(value.name).replaceAll('"', '') === TARGET);
    const target = existing
      ? { uuid: existing[0], pbxNativeTarget: existing[1] }
      : project.addTarget(TARGET, 'app_extension', TARGET, `${config.ios.bundleIdentifier}.voiceactivity`);
    const sources = [`${TARGET}/CalabVoiceActivity.swift`, `${TARGET}/CalabVoiceAttributes.swift`, ...(calendar ? calendarSources.map(name => `${TARGET}/${name}`) : [])];
    if (!existing) project.addBuildPhase(sources, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    if (!project.findPBXGroupKey({ name: TARGET })) {
      const group = project.addPbxGroup(sources, TARGET);
      // The file references already include TARGET; this group is organizational only.
      Reflect.deleteProperty(group.pbxGroup, 'path');
      project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    }
    if (existing && calendar) for (const source of sources) {
      const present = Object.values(project.pbxFileReferenceSection()).some(ref => typeof ref === 'object' && String(ref.path).replaceAll('"', '') === source);
      if (!present) project.addSourceFile(source, { target: target.uuid }, project.findPBXGroupKey({ name: TARGET }));
    }
    // node-xcode emits optional undefined fields literally; narrow cleanup to our references.
    for (const reference of Object.values(project.pbxFileReferenceSection())) {
      if (!reference || typeof reference !== 'object') continue;
      const name = String(reference.name ?? '').replaceAll('"', '');
      if (!['CalabVoiceActivity.swift', 'CalabVoiceAttributes.swift', ...calendarSources, `${TARGET}.appex`].includes(name)) continue;
      for (const [key, value] of Object.entries(reference)) {
        if (value === undefined || value === 'undefined') Reflect.deleteProperty(reference, key);
      }
      if (name.endsWith('.swift')) reference.lastKnownFileType = 'sourcecode.swift';
      else reference.explicitFileType = '"wrapper.app-extension"';
    }
    const list = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
    for (const entry of list.buildConfigurations) {
      Object.assign(project.pbxXCBuildConfigurationSection()[entry.value].buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: 'YES',
        CODE_SIGN_STYLE: 'Automatic',
        PRODUCT_BUNDLE_IDENTIFIER: `${config.ios.bundleIdentifier}.voiceactivity`,
        CURRENT_PROJECT_VERSION: config.ios.buildNumber ?? '1',
        MARKETING_VERSION: config.version ?? '0.1.0',
        IPHONEOS_DEPLOYMENT_TARGET: config.ios.deploymentTarget ?? '16.4',
        SDKROOT: 'iphoneos',
        SWIFT_VERSION: '5.0',
        TARGETED_DEVICE_FAMILY: '1',
        GENERATE_INFOPLIST_FILE: 'NO',
        CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
        SWIFT_ACTIVE_COMPILATION_CONDITIONS: calendar ? '"$(inherited) CALAB_CALENDAR_WIDGETS"' : '"$(inherited)"',
      });
    }
    return mod;
  });
};
