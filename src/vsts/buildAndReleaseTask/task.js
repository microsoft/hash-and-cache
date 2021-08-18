// safety first - handle and exit non-zero if we run into issues
let abortProcess = e => {
  console.log(e);
  process.exit(1);
};
process.on("uncaughtException", abortProcess);
process.on("unhandledRejection", abortProcess);

const tl = require('vsts-task-lib/task');
var crypto = require('crypto');
var azureStorage = require('azure-storage');
var path = require('path');
var tar = require('tar');
var glob = require('glob');
var fs = require('fs');
var mkdirp = require('mkdirp');
var { execSync } = require('child_process');

var sourceIgnore = tl.getInput('sourceIgnore') || '';
var outputFiles = tl.getInput('outputFiles') || '';
var outputIgnore = tl.getInput('outputIgnore') || '';

var options = {
  sourcePath: tl.getPathInput('sourcePath', true, true),
  sourceFiles: tl.getInput('sourceFiles', true).split(/\r?\n/),
  sourceIgnore: sourceIgnore.split(/\r?\n/),
  hashSuffix: tl.getInput('hashSuffix'),
  execWorkingDirectory: tl.getPathInput('execWorkingDirectory'),
  execCommand: tl.getInput('execCommand'),
  storageAccount: tl.getInput('storageAccount'),
  storageContainer: tl.getInput('storageContainer'),
  storageKey: tl.getInput('storageKey'),
  outputPath: tl.getInput('outputPath'),
  outputFiles: outputFiles.split(/\r?\n/),
  outputIgnore: outputIgnore.split(/\r?\n/),
  uploadCacheOnMiss: tl.getBoolInput('uploadCacheOnMiss'),
  downloadCacheOnHit: tl.getBoolInput('downloadCacheOnHit')
}

// calling this function prints all the variables if System.Debug == true
tl.getVariables();

var hashAndCache = function (options) {
  options.sourcePath = options.sourcePath || process.cwd();
  options.sourceFiles = options.sourceFiles || ["**"];
  if (typeof options.sourceFiles === 'string') options.sourceFiles = [options.sourceFiles];
  options.sourceIgnore = options.sourceIgnore || "";
  options.hashSuffix = options.hashSuffix || "";
  options.execWorkingDirectory = options.execWorkingDirectory || process.cwd();
  options.execCommand = options.execCommand || null;
  options.storageAccount = options.storageAccount || null;
  options.storageContainer = options.storageContainer || null;
  options.storageKey = options.storageKey || null;
  options.outputPath = options.outputPath || process.cwd();
  options.outputFiles = options.outputFiles || ["**"];
  options.outputIgnore = options.outputIgnore || "";
  if (typeof options.outputFiles === 'string') options.outputFiles = [options.outputFiles];
  options.downloadCacheOnHit = options.downloadCacheOnHit === false ? false : true;
  options.uploadCacheOnMiss = options.uploadCacheOnMiss === true;

  var hash = generateHash(options.sourcePath, options.sourceFiles, options.sourceIgnore, options.hashSuffix, options.execCommand);

  doesCacheExist(hash, options.storageAccount, options.storageContainer, options.storageKey).then(function (result) {
    if (result) {
      console.log(result, "CACHE HIT!");

      if (options.downloadCacheOnHit) {
        downloadCache(hash, options.storageAccount, options.storageContainer, options.storageKey, options.outputPath).then(function () {
          extractCache(options.outputPath, hash);
          deleteCache(options.outputPath, hash);
        }).catch(function () { onCacheMiss(options) });
      }
    } else {
      console.log("CACHE MISS!");
      return onCacheMiss(options);
    }
  });
}

var onCacheMiss = function (options) {
  if (options.execCommand) {
    console.log("Running Command " + options.execCommand);
    execSync(options.execCommand, { cwd: options.execWorkingDirectory, stdio: 'inherit' });
  } else {
    console.log("No command specified - skipping");
  }

  if (options.uploadCacheOnMiss) {
    var files = getFileList(options.outputPath, options.outputFiles, options.outputIgnore);

    if (!files || files.length == 0) {
      console.log("No output files found - skipping cache update");
      return;
    }

    var tarFile = hash + ".tgz";
    var tarPath = path.join(options.outputPath, tarFile);
    // the tar library doesn't like paths that start with @ - need to add ./ to the start
    files = files.map(function (value) { return value.startsWith('@') ? './' + value : value });

    console.log("Creating tarball " + tarPath);

    var tarOptions = {
      sync: true,
      file: tarPath,
      strict: true,
      gzip: true,
      portable: true,
      noMtime: true,
      cwd: options.outputPath
    }

    tar.create(tarOptions, files);
    uploadCache(tarPath, tarFile, options.storageAccount, options.storageContainer, options.storageKey)
      .then(function () {
        fs.unlinkSync(tarPath);
      })
      .catch(function (err) {
        console.warn("Uploading of cache failed. This may happen when attempting to upload in parallel.")
        console.warn(err);
      });
  }
}

var generateHash = function (sourcePath, sourceFiles, sourceIgnore, hashSuffix, execCommand) {
  console.log("Generating Hash...");
  console.log("sourcePath: " + sourcePath);
  console.log("sourceFiles: " + sourceFiles);
  console.log("sourceIgnore: " + sourceIgnore);
  console.log("hashSuffix: " + hashSuffix);
  console.log("execCommand: " + execCommand);

  var files = getFileList(sourcePath, sourceFiles, sourceIgnore);

  console.log("Hashing " + files.length + " files...");

  var hashAlgorithm = crypto.createHash('sha256');

  files.forEach(function (file) {
    var filePath = path.join(sourcePath, file);
    hashAlgorithm.update(fs.readFileSync(filePath));
    hashAlgorithm.update(path.relative(sourcePath, filePath));
  });

  hashAlgorithm.update(hashSuffix);
  hashAlgorithm.update(execCommand);

  var hash = hashAlgorithm.digest('hex');

  console.log("Hash = " + hash);

  return hash;
}

var getFileList = function (workingDirectory, globs, ignoreGlob) {
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

  var filesUnique = files.sort().filter(function (item, pos, ary) {
    return !pos || item != ary[pos - 1];
  });

  return filesUnique;
}

var doesCacheExist = function (hash, storageAccount, storageContainer, storageKey) {
  console.log("Checking for cache...");
  console.log("hash: " + hash);
  console.log("storageAccount: " + storageAccount);
  console.log("storageContainer: " + storageContainer);

  if (storageAccount && storageContainer && storageKey) {
    var blobName = hash + ".tgz";

    var blobService = azureStorage.createBlobService(storageAccount, storageKey);

    var blobPromise = new Promise((resolve, reject) => {
      blobService.doesBlobExist(storageContainer, blobName, (err, result) => {
        if (err) {
          console.log("looks like blob does not exist", err);
          resolve(false);
        } else {
          resolve(result.exists);
        }
      });
    });

    return blobPromise;
  }

  console.log("Storage Account details missing - skipping cache check");
  return new Promise((resolve, reject) => resolve(false));
}

var downloadCache = function (hash, storageAccount, storageContainer, storageKey, targetPath) {
  console.log("Downloading Blob...");
  console.log("hash: " + hash);
  console.log("storageAccount: " + storageAccount);
  console.log("storageContainer: " + storageContainer);
  console.log("targetPath: " + targetPath);

  if (storageAccount && storageContainer && storageKey) {
    var blobName = hash + ".tgz";
    var downloadFile = path.join(targetPath, blobName);

    mkdirp.sync(targetPath);

    var blobService = azureStorage.createBlobService(storageAccount, storageKey);

    var blobOptions = {
      timeoutIntervalInMs: 3600000,
      clientRequestTimeoutInMs: 3600000,
      maximumExecutionTimeInMs: 3600000
    }

    var downloadPromise = new Promise((resolve, reject) => {
      blobService.getBlobToLocalFile(storageContainer, blobName, downloadFile, blobOptions, err => {
        if (err) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    return downloadPromise;
  }

  console.log("Storage Account details missing - skipping cache download");
  return new Promise((resolve, reject) => resolve(false));
}

var uploadCache = function (blobPath, blobName, storageAccount, storageContainer, storageKey) {
  console.log("Uploading blob...");
  console.log("blobPath: " + blobPath);
  console.log("blobName: " + blobName);
  console.log("storageAccount: " + storageAccount);
  console.log("storageContainer: " + storageContainer);

  if (storageAccount && storageContainer && storageKey) {
    var blobService = azureStorage.createBlobService(storageAccount, storageKey);

    var blobOptions = {
      timeoutIntervalInMs: 3600000,
      clientRequestTimeoutInMs: 3600000,
      maximumExecutionTimeInMs: 3600000
    }

    var uploadPromise = new Promise((resolve, reject) => {
      blobService.createBlockBlobFromLocalFile(storageContainer, blobName, blobPath, blobOptions, err => {
        if (err) {
          reject(err);
        } else {
          resolve(true);
        }
      });
    });

    return uploadPromise;
  }

  console.log("Storage Account details missing - skipping cache upload");
  return new Promise((resolve, reject) => resolve(true));
}

var extractCache = function (targetPath, hash) {
  var tarFile = hash + ".tgz";
  var tarPath = path.join(targetPath, tarFile);

  console.log("Extracting Cache " + tarPath);

  var tarOptions = {
    sync: true,
    file: tarPath,
    strict: true,
    noMtime: true,
    cwd: targetPath
  }

  tar.extract(tarOptions);
}

var deleteCache = function (targetPath, hash) {
  var cacheFile = hash + ".tgz";
  var cachePath = path.join(targetPath, cacheFile);

  console.log("Deleting Cache File " + cachePath);

  fs.unlinkSync(cachePath);
}


hashAndCache(options);
