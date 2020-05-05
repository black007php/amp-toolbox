/**
 * Copyright 2020 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'mode strict';

const validatorRulesProvider = require('@ampproject/toolbox-validator-rules');
const {MaxAge, FileSystemCache} = require('@ampproject/toolbox-core');
const {join} = require('path');
const {mkdirSync, existsSync} = require('fs');
const {AMP_CACHE_HOST, AMP_RUNTIME_CSS_PATH, appendRuntimeVersion} = require('./AmpConstants.js');

const KEY_VALIDATOR_RULES = 'validator-rules';
const AMP_RUNTIME_MAX_AGE = 10 * 60; // 10 min

const cacheDir = join(__dirname, '../.cache');
const cache = FileSystemCache.get({
  baseDir: cacheDir,
});

/**
 * Initializes the runtime parameters used by the transformers based on given config and parameter values.
 * If missing, the following parameters are fetched from cdn.ampproject.org:
 *
 * - validatorRules: the latest version of the AMP validator rules as served from https://cdn.ampproject.org/v0/validator.json
 * - ampRuntimeVersion: the latest AMP runtime version or the latest lts version if the lts flag is set
 * - ampRuntimeStules: the latest AMP runtime CSS styles or the latest lts version if the lts flag is set
 *
 * @param {Object} config - the AMP Optimizer config
 * @param {Object} customRuntimeParameters - user defined runtime parameters
 * @returns {Promise<Object>} - the runtime parameters
 */
async function fetchRuntimeParameters(config, customRuntimeParameters) {
  const runtimeParameters = Object.assign({}, customRuntimeParameters);
  // Configure the log level
  runtimeParameters.verbose = customRuntimeParameters.verbose || config.verbose || false;
  // Copy lts and rtv runtime flag from custom parameters or the static config. Both are disabled by default.
  runtimeParameters.lts = customRuntimeParameters.lts || config.lts || false;
  runtimeParameters.rtv = customRuntimeParameters.rtv || config.rtv || false;
  // Fetch the validator rules
  try {
    runtimeParameters.validatorRules = config.validatorRules || (await fetchValidatorRules_());
  } catch (error) {
    config.log.error('Could not fetch validator rules', error);
  }
  let {ampUrlPrefix, ampRuntimeVersion, ampRuntimeStyles, lts} = runtimeParameters;
  // Use existing runtime version or fetch lts or latest
  try {
    runtimeParameters.ampRuntimeVersion =
      ampRuntimeVersion || (await fetchAmpRuntimeVersion_({config, ampUrlPrefix, lts}));
  } catch (error) {
    config.log.error('Could not fetch latest AMP runtime version', error);
  }
  // Fetch runtime styles based on the runtime version
  try {
    runtimeParameters.ampRuntimeStyles =
      ampRuntimeStyles ||
      (await fetchAmpRuntimeStyles_(config, ampUrlPrefix, runtimeParameters.ampRuntimeVersion));
  } catch (error) {
    config.log.error('Could not fetch AMP runtime CSS', error);
  }
  return runtimeParameters;
}

/**
 * @private
 */
async function fetchAmpRuntimeStyles_(config, ampUrlPrefix, ampRuntimeVersion) {
  if (ampUrlPrefix && !_isAbsoluteUrl(ampUrlPrefix)) {
    config.log.warn(
      `AMP runtime styles cannot be fetched from relative ampUrlPrefix, please use the 'ampRuntimeStyles' parameter to provide the correct runtime style.`
    );
    // Gracefully fallback to latest runtime version
    ampUrlPrefix = AMP_CACHE_HOST;
    ampRuntimeVersion = ampRuntimeVersion || (await config.runtimeVersion.currentVersion());
  }
  // Construct the AMP runtime CSS download URL, the default is: https://cdn.ampproject.org/rtv/${ampRuntimeVersion}/v0.css
  const runtimeCssUrl =
    appendRuntimeVersion(ampUrlPrefix || AMP_CACHE_HOST, ampRuntimeVersion) + AMP_RUNTIME_CSS_PATH;
  // Fetch runtime styles
  const styles = await downloadAmpRuntimeStyles_(config, runtimeCssUrl);
  if (!styles) {
    config.log.error(`Could not download ${runtimeCssUrl}`);
    if (ampUrlPrefix || ampRuntimeVersion) {
      // Try to download latest from cdn.ampproject.org instead
      return fetchAmpRuntimeStyles_(AMP_CACHE_HOST, await config.runtimeVersion.currentVersion());
    } else {
      return '';
    }
  }
  return styles;
}

/**
 * @private
 */
async function downloadAmpRuntimeStyles_(config, runtimeCssUrl) {
  let styles = await cache.get(runtimeCssUrl);
  if (!styles) {
    const response = await config.fetch(runtimeCssUrl);
    if (!response.ok) {
      return null;
    }
    styles = await response.text();
    cache.set(runtimeCssUrl, styles);
  }
  return styles;
}

/**
 * @private
 */
async function fetchAmpRuntimeVersion_(context) {
  const versionKey = context.ampUrlPrefix + '-' + context.lts;
  let ampRuntimeData = await cache.get(versionKey);
  if (!ampRuntimeData) {
    ampRuntimeData = await fetchLatestRuntimeData_(versionKey, context);
  } else if (MaxAge.fromJson(ampRuntimeData.maxAge).isExpired()) {
    // return the cached version, but update the cache in the background
    fetchLatestRuntimeData_(versionKey, context);
  }
  return ampRuntimeData.version;
}

/**
 * @private
 */
async function fetchLatestRuntimeData_(versionKey, {config, ampUrlPrefix, lts}) {
  const ampRuntimeData = {
    version: await config.runtimeVersion.currentVersion({ampUrlPrefix, lts}),
    maxAge: MaxAge.create(AMP_RUNTIME_MAX_AGE).toJson(),
  };
  console.log('set version', versionKey, ampRuntimeData);
  cache.set(versionKey, ampRuntimeData);
  return ampRuntimeData;
}

/**
 * @private
 */
async function fetchValidatorRules_() {
  let rawRules = await cache.get('validator-rules');
  let validatorRules;
  if (!rawRules) {
    validatorRules = await validatorRulesProvider.fetch();
    // We save the raw rules to make the validation rules JSON serializable
    cache.set(KEY_VALIDATOR_RULES, validatorRules.raw);
  } else {
    validatorRules = await validatorRulesProvider.fetch({rules: rawRules});
  }
  return validatorRules;
}

/**
 * @private
 */
function _isAbsoluteUrl(url) {
  try {
    new URL(url);
    return true;
  } catch (ex) {}

  return false;
}

module.exports = fetchRuntimeParameters;