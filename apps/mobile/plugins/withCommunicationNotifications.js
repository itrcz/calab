// Standard communication presentation; no shared credentials, storage, or extension network access.
const fs = require('node:fs');
const path = require('node:path');
const { withInfoPlist, withXcodeProject, withEntitlementsPlist } = require('expo/config-plugins');

const TARGET = 'CalabNotificationService';
const SOURCES = ['NotificationService.swift', 'CalabCommunication.swift', 'CalabCommunicationPayload.swift'];

module.exports = (config) => {
  if (!config.ios?.bundleIdentifier || !config.ios.entitlements?.['aps-environment']) return config;
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.developer.usernotifications.communication'] = true;
    return mod;
  });
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSUserActivityTypes = [...new Set([...(mod.modResults.NSUserActivityTypes ?? []), 'INSendMessageIntent', 'INStartCallIntent'])];
    return mod;
  });
  return withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const root = mod.modRequest.platformProjectRoot;
    const destination = path.join(root, TARGET);
    fs.mkdirSync(destination, { recursive: true });
    for (const source of SOURCES) {
      const directory = source === 'NotificationService.swift' ? 'notifications' : 'modules/calab-session-activity/ios';
      fs.copyFileSync(path.join(mod.modRequest.projectRoot, directory, source), path.join(destination, source));
    }
    // Communication Notifications belongs to the containing app, as in Apple's sample.
    // The NSE uses its ordinary profile; requesting this grant there blocks signing.
    fs.writeFileSync(path.join(destination, `${TARGET}.entitlements`), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict/></plist>\n`);
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
<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string><key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).NotificationService</string></dict>
</dict></plist>\n`);
    // CocoaPods/xcodeproj removes unnecessary quotes when it saves the project.
    const existing = Object.entries(project.pbxNativeTargetSection()).find(([key, value]) => !key.endsWith('_comment') && String(value.name).replaceAll('"', '') === TARGET);
    const target = existing
      ? { uuid: existing[0], pbxNativeTarget: existing[1] }
      : project.addTarget(TARGET, 'app_extension', TARGET, `${config.ios.bundleIdentifier}.notifications`);
    const sources = SOURCES.map((source) => `${TARGET}/${source}`);
    if (!existing) project.addBuildPhase(sources, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    if (!project.findPBXGroupKey({ name: TARGET })) {
      const group = project.addPbxGroup(sources, TARGET);
      // The file references already include TARGET; this group is organizational only.
      Reflect.deleteProperty(group.pbxGroup, 'path');
      project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    }
    // node-xcode emits optional undefined fields literally; narrow cleanup to our references.
    for (const reference of Object.values(project.pbxFileReferenceSection())) {
      if (!reference || typeof reference !== 'object') continue;
      const name = String(reference.name ?? '').replaceAll('"', '');
      if (![...SOURCES, `${TARGET}.appex`].includes(name)) continue;
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
        CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
        CURRENT_PROJECT_VERSION: config.ios.buildNumber ?? '1',
        MARKETING_VERSION: config.version ?? '0.1.0',
        IPHONEOS_DEPLOYMENT_TARGET: config.ios.deploymentTarget ?? '16.4',
        SDKROOT: 'iphoneos',
        SWIFT_VERSION: '5.0',
        TARGETED_DEVICE_FAMILY: '1',
        GENERATE_INFOPLIST_FILE: 'NO',
      });
    }
    return mod;
  });
};
