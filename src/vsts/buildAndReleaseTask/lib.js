const tl = require('vsts-task-lib/task');
const crypto = require('crypto');
const azureStorage = require('azure-storage');
const path = require('path');
const tar = require('tar');
const glob = require('glob');
const fs = require('fs');
const mkdirp = require('mkdirp');
const { execSync } = require('child_process');

let blobService;

const tarFileName = hash => hash + ".tgz";
const logParameter = p => console.log("\t" + p);
const execCommand = (cmd, wd) => {
  if(!!cmd && !!wd) {
    execSync(cmd, { cwd: wd, stdio: 'inherit' });
  } else {
    console.log("No command specified - skipping");
  }
}

function resolveOptions() {

  let options = {};

  options.sourcePath = 
    tl.getPathInput('sourcePath', true, true) || process.cwd();

  options.sourceFiles = 
    (tl.getInput('sourceFiles', true) || '').split(/\r?\n/) || ['**'];
  if (typeof options.sourceFiles === 'string') options.sourceFiles = [options.sourceFiles];

  options.sourceIgnore = 
    (tl.getInput('sourceIgnore') || '').split(/\r?\n/);

  options.hashSuffix =  
    tl.getInput('hashSuffix') || '';

  options.execWorkingDirectory = 
    tl.getPathInput('execWorkingDirectory') || process.cwd();

  options.execCommand = 
    tl.getInput('execCommand') || null;

  options.storageAccount = 
    tl.getInput('storageAccount') || null;

  options.storageContainer = 
    tl.getInput('storageContainer') || null;

  options.storageKey = 
    tl.getInput('storageKey') || null;

  options.outputPath = 
    tl.getPathInput('outputPath') || process.cwd();

  options.outputFiles = 
    (tl.getInput('outputFiles') || '').split(/\r?\n/) || ['**'];
  if (typeof options.outputFiles === 'string') options.outputFiles = [options.outputFiles];

  options.outputIgnore = 
    (tl.getInput('outputIgnore') || '').split(/\r?\n/) || ['**'];
  if (typeof options.outputIgnore === 'string') options.outputIgnore = [options.outputIgnore];

  options.downloadCacheOnHit = 
    tl.getBoolInput('uploadCacheOnMiss') === false ? false : true;

  options.uploadCacheOnMiss = 
    tl.getBoolInput('downloadCacheOnHit') === true;

  return options;
}

function getGlobalBlobService(storageAccount, storageContainer, storageKey) {
  if(blobService) return blobService;

  console.log("Creating blob service...");
  logParameter("storageAccount: " + storageAccount);

  if (storageAccount && storageContainer && storageKey) {
    blobService = azureStorage.createBlobService(storageAccount, storageKey);
    return blobService;
  } else {
    throw "Storage Account details missing - cannot create blob service.";
  }
}

function extractCache(targetPath, hash) {
  var tarPath = path.join(targetPath, tarFileName(hash));

  console.log("Extracting Cache " + tarPath);

  const tarOptions = {
    sync: true,
    file: tarPath,
    strict: true,
    noMtime: true,
    cwd: targetPath
  }

  tar.extract(tarOptions);
}

function deleteCache(targetPath, hash) {
  var cachePath = path.join(targetPath, tarFileName(hash));

  console.log("Deleting Cache File " + cachePath);

  fs.unlinkSync(cachePath);
}

function createCache(hash, outputPath, outputFiles, outputIgnore) {
  console.log("Creating cache...");
  logParameter("hash: " + hash);
  logParameter("outputPath: " + outputPath);
  logParameter("outputFiles: " + outputFiles);
  logParameter("outputIgnore: " + outputIgnore);

  let files = getFileList(outputPath, outputFiles, outputIgnore);

  if (!files || files.length == 0) {
    console.log("No output files found - skipping cache creation.");
    return;
  }

  let tarFile = tarFileName(hash);
  let tarPath = path.join(outputPath, tarFile);

  // the tar library doesn't like paths that start with @ - need to add ./ to the start
  files = files.map(function(value) { return value.startsWith('@') ? './' + value : value });

  console.log("Creating tarball " + tarPath);

  const tarOptions = {
    sync: true,
    file: tarPath,
    strict: true,
    gzip: true,
    portable: true,
    noMtime: true,
    cwd: options.outputPath
  }

  tar.create(tarOptions, files);
}

function uploadCache(blobPath, blobName, storageContainer) {
  console.log("Uploading to blob...");
  logParameter("blobPath: " + blobPath);
  logParameter("blobName: " + blobName);
  logParameter("storageContainer: " + storageContainer);

  const blobOptions = {
    timeoutIntervalInMs: 3600000,
    clientRequestTimeoutInMs: 3600000,
    maximumExecutionTimeInMs: 3600000
  }

  return new Promise((resolve, reject) => {
    getGlobalBlobService().createBlockBlobFromLocalFile(storageContainer, blobName, blobPath, blobOptions, err => {
      if (err) {
        reject(err);
      } else {
        resolve(true);
      }
    });
  });
}

function downloadCache(hash, storageContainer, targetPath) {
  console.log("Downloading Blob...");
  logParameter("hash: " + hash);
  logParameter("storageContainer: " + storageContainer);
  logParameter("targetPath: " + targetPath);
  
  const blobName = tarFileName(hash);
  const downloadFile = path.join(targetPath, blobName);

  mkdirp.sync(targetPath);

  const blobOptions = {
    timeoutIntervalInMs: 3600000,
    clientRequestTimeoutInMs: 3600000,
    maximumExecutionTimeInMs: 3600000
  }

  return new Promise((resolve, reject) => {
    getGlobalBlobService().getBlobToLocalFile(storageContainer, blobName, downloadFile, blobOptions, err => {
      if (err) {
        reject(false);
      } else {
        resolve(true);
      }
    });
  });
}

function doesCacheExist(hash, storageContainer) {
  console.log("Checking for cache...");
  logParameter("hash: " + hash);
  logParameter("storageContainer: " + storageContainer);

  var blobName = tarFileName(hash);

  return new Promise((resolve, reject) => {
    getGlobalBlobService().doesBlobExist(storageContainer, blobName, (err, result) => {
      if (err) {
        console.log("CACHE MISS!");
        resolve(false);
      } else {
        result.exists ? console.log("CACHE HIT!") : console.log("CACHE MISS!");
        resolve(result.exists)
      }
    });
  });
}

function downloadAndExtractCache(storageContainer, outputPath, hash) {
  downloadCache(hash, storageContainer, outputPath).then(function() {
    extractCache(outputPath, hash);
    deleteCache(outputPath, hash);
  });
}

function getFileList(workingDirectory, globs, ignoreGlob) {
  var files = [];

  if (!workingDirectory || !fs.existsSync(workingDirectory)) {
    console.log("Skipping globbing because root directory does not exist [" + workingDirectory + "]");
    return files;
  }

  var globOptions = {
    cwd: workingDirectory,
    dot: true,
    nodir: true,
    ignore: ignoreGlob
  }

  for (let g of globs) {
    files = files.concat(glob.sync(g, globOptions));
  }

  var filesUnique =  files.sort().filter(function(item, pos, ary) {
    return !pos || item != ary[pos - 1];
  });

  return filesUnique;
}

function generateHash(sourcePath, sourceFiles, sourceIgnore, hashSuffix, execCommand) {
  console.log("Generating Hash...");
  logParameter("sourcePath: " + sourcePath);
  logParameter("sourceFiles: " + sourceFiles);
  logParameter("sourceIgnore: " + sourceIgnore);
  logParameter("hashSuffix: " + hashSuffix);
  logParameter("execCommand: " + execCommand);

  const files = getFileList(sourcePath, sourceFiles, sourceIgnore);

  console.log("Hashing " + files.length + " files...");

  let hashAlgorithm = crypto.createHash('sha256');

  files.forEach(function (file) {
    let filePath = path.join(sourcePath, file);
    hashAlgorithm.update(fs.readFileSync(filePath));
    hashAlgorithm.update(path.relative(sourcePath, filePath));
  });

  hashAlgorithm.update(hashSuffix);
  hashAlgorithm.update(execCommand);

  let hash = hashAlgorithm.digest('hex');

  console.log("Hash = " + hash);

  return hash;
}

var hashAndCache = function () {

  let options = resolveOptions();

  getGlobalBlobService(options.storageAccount, options.storageContainer, options.storageKey);
  
  const hash = generateHash(options.sourcePath, options.sourceFiles, options.sourceIgnore, options.hashSuffix, options.execCommand);

  doesCacheExist(hash, options.storageContainer)
  .then(result => {
    if(result) { //cache hit
      options.downloadCacheOnHit ? downloadAndExtractCache(options.storageContainer, options.outputPath, hash) : null;
    } else { //cache miss
      execCommand(options.execCommand, options.execWorkingDirectory);

      if(options.uploadCacheOnMiss) {
        var tarFile = tarFileName(hash);
        var tarPath = path.join(options.outputPath, tarFile);

        createCache(hash, options.outputPath, options.outputFiles, options.outputIgnore);
        uploadCache(tarPath, tarFile, options.storageContainer).then(function() {
          fs.unlinkSync(tarPath);
        });
      }
    }
  })
  .catch(e => console.error(e));
}


module.exports.tl = tl;
module.exports.azureStorage = azureStorage;
module.exports.tar = tar;
module.exports.fs = fs;

module.exports.resolveOptions = resolveOptions;
module.exports.getGlobalBlobService = getGlobalBlobService;
module.exports.extractCache = extractCache;
module.exports.deleteCache = deleteCache;
module.exports.createCache = createCache;
module.exports.uploadCache = uploadCache;
module.exports.downloadCache = downloadCache;
module.exports.doesCacheExist = doesCacheExist;
module.exports.downloadAndExtractCache = downloadAndExtractCache;
module.exports.getFileList = getFileList;
module.exports.generateHash = generateHash;

module.exports.hashAndCache = hashAndCache;
