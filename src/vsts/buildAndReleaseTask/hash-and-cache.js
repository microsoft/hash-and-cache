var crypto = require('crypto');
var azureStorage = require('azure-storage');
var path = require('path');
var tar = require('tar');
var glob = require('glob');
var fs = require('fs');
var mkdirp = require('mkdirp');
var { execSync } = require('child_process');

module.exports = async function (options) {
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
  options.skipExec = options.skipExec === true? true : false;

  var hash = generateHash(options.sourcePath, options.sourceFiles, options.sourceIgnore, options.hashSuffix, options.execCommand);

  if (await doesCacheExist(hash, options.storageAccount, options.storageContainer, options.storageKey)) {
    console.log("CACHE HIT!");
    console.log("##vso[task.setvariable variable=cacheHit]true");

    if (options.downloadCacheOnHit) {
      try {
        await downloadCache(hash, options.storageAccount, options.storageContainer, options.storageKey, options.outputPath);
        extractCache(options.outputPath, hash);
        deleteCache(options.outputPath, hash);
        return;
      } catch (e) {
        console.log("error - falling back to cache miss:", e)
      }
    }
  }

  console.log("CACHE MISS!");
  console.log("##vso[task.setvariable variable=cacheHit]false");

  if (options.execCommand && !options.skipExec) {
    console.log("Running Command " + options.execCommand);
    execSync(options.execCommand, { cwd: options.execWorkingDirectory, stdio: 'inherit' });
  } else {
    if (options.skipExec) {
      console.log("Skipping exec command (options.skipExec = true)");
    } else {
      console.log("No command specified - skipping");
    }
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
    files = files.map(function(value) { return value.startsWith('@') ? './' + value : value });

    console.log("Creating tarball " + tarPath);

    var tarOptions = {
      sync: true,
      file: tarPath,
      strict: true,
      gzip: true,
      cwd: options.outputPath
    }

    tar.create(tarOptions, files);
    await uploadCache(tarPath, tarFile, options.storageAccount, options.storageContainer, options.storageKey);
    fs.unlinkSync(tarPath);
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

  var filesUnique =  files.sort().filter(function(item, pos, ary) {
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
          resolve(false);
        } else {
          resolve(result.exists)
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
    cwd: targetPath
  }

  return tar.extract(tarOptions);
}

var deleteCache = function (targetPath, hash) {
  var cacheFile = hash + ".tgz";
  var cachePath = path.join(targetPath, cacheFile);

  console.log("Deleting Cache File " + cachePath);

  return fs.unlinkSync(cachePath);
}