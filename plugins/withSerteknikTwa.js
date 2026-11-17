const {
  withAndroidManifest,
  withAppBuildGradle,
  withStringsXml,
} = require('expo/config-plugins');

const ORIGIN = 'https://serteknik.elektrik.workers.dev';
const HELPER = 'com.google.androidbrowserhelper:androidbrowserhelper:2.7.4';
// Android string resources treat unescaped quotes as delimiters; preserve JSON quotes for AAPT.
const ASSET_STATEMENT = JSON.stringify([
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'web', site: ORIGIN },
  },
]).replace(/"/g, '\\"');

function withTwaDependency(config) {
  return withAppBuildGradle(config, (mod) => {
    const contents = mod.modResults.contents;
    if (!contents.includes(HELPER)) {
      const dependencyBlock = contents.indexOf('dependencies {');
      if (dependencyBlock < 0) {
        throw new Error('SerTeknik TWA: Android app dependencies block not found.');
      }
      const insertAt = dependencyBlock + 'dependencies {'.length;
      mod.modResults.contents =
        contents.slice(0, insertAt) +
        `\n    implementation '${HELPER}'` +
        contents.slice(insertAt);
    }
    return mod;
  });
}

function withTwaAssetStatement(config) {
  return withStringsXml(config, (mod) => {
    const resources = mod.modResults.resources;
    const strings = Array.isArray(resources.string) ? resources.string : [];
    const existing = strings.find((item) => item.$?.name === 'asset_statements');
    if (existing) {
      existing.$ = { ...existing.$, translatable: 'false' };
      existing._ = ASSET_STATEMENT;
    } else {
      strings.push({
        $: { name: 'asset_statements', translatable: 'false' },
        _: ASSET_STATEMENT,
      });
    }
    resources.string = strings;
    return mod;
  });
}

function withTwaLauncher(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('SerTeknik TWA: Android application manifest entry not found.');
    }

    const activities = Array.isArray(application.activity) ? application.activity : [];
    application.activity = activities;
    const mainActivity = activities.find((activity) =>
      String(activity.$?.['android:name'] || '').endsWith('MainActivity'),
    );
    if (!mainActivity) {
      throw new Error('SerTeknik TWA: Expo MainActivity not found in Android manifest.');
    }
    mainActivity['intent-filter'] = (mainActivity['intent-filter'] || []).filter((filter) => {
      const isMain = (filter.action || []).some((entry) => entry.$?.['android:name'] === 'android.intent.action.MAIN');
      const isLauncher = (filter.category || []).some((entry) => entry.$?.['android:name'] === 'android.intent.category.LAUNCHER');
      return !(isMain && isLauncher);
    });

    const className = 'com.google.androidbrowserhelper.trusted.LauncherActivity';
    let launcher = activities.find((activity) => activity.$?.['android:name'] === className);
    const metadata = [
      {
        $: {
          'android:name': 'android.support.customtabs.trusted.DEFAULT_URL',
          'android:value': `${ORIGIN}/`,
        },
      },
      {
        $: {
          'android:name': 'android.support.customtabs.trusted.DISPLAY_MODE',
          'android:value': 'immersive',
        },
      },
    ];
    const launcherFilter = {
      action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
      category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
    };

    if (!launcher) {
      launcher = {
        $: {
          'android:name': className,
          'android:label': '@string/app_name',
          'android:exported': 'true',
          'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
        },
      };
      activities.push(launcher);
    } else {
      launcher.$ = {
        ...launcher.$,
        'android:label': '@string/app_name',
        'android:exported': 'true',
        'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
      };
    }
    launcher['meta-data'] = metadata;
    launcher['intent-filter'] = [launcherFilter];

    const appMetadata = Array.isArray(application['meta-data']) ? application['meta-data'] : [];
    application['meta-data'] = appMetadata.filter((item) => item.$?.['android:name'] !== 'asset_statements');
    application['meta-data'].push({
      $: {
        'android:name': 'asset_statements',
        'android:resource': '@string/asset_statements',
      },
    });
    return mod;
  });
}

module.exports = function withSerteknikTwa(config) {
  config = withTwaDependency(config);
  config = withTwaAssetStatement(config);
  config = withTwaLauncher(config);
  return config;
};
