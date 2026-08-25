package com.itantra.stt

import android.content.Context
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

object ModelManager {
    @Volatile
    var isDownloadCancelled = false

    private val languageModelMapping = mapOf(
        "en" to "vosk-model-small-en-in-0.4",
        "hi" to "vosk-model-small-hi-0.22",
        "bn" to "vosk-model-bn-0.2"
    )

    private val languageUrlMapping = mapOf(
        "en" to "https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip",
        "hi" to "https://alphacephei.com/vosk/models/vosk-model-small-hi-0.22.zip"
    )

    fun getModelPath(context: Context, language: String): String? {
        val modelFolderName = languageModelMapping[language] ?: return null
        val externalFilesDir = context.getExternalFilesDir(null)
        val destFolder = File(externalFilesDir, "models/stt/$language")
        val actualModelDir = File(destFolder, modelFolderName)

        if (actualModelDir.exists() && actualModelDir.isDirectory) {
            return actualModelDir.absolutePath
        }

        if (destFolder.exists() && destFolder.isDirectory) {
            // For cases where we just extracted directly without the root folder, or renaming
            return destFolder.absolutePath
        }

        // Check if we can copy from assets (bundled models)
        val assetPath = "models/stt/$language/$modelFolderName"
        try {
            val assets = context.assets.list(assetPath)
            if (!assets.isNullOrEmpty()) {
                if (!actualModelDir.exists()) actualModelDir.mkdirs()
                if (copyAssetFolder(context, assetPath, actualModelDir.absolutePath)) {
                    return actualModelDir.absolutePath
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        
        return null
    }

    private fun copyAssetFolder(context: Context, srcPath: String, destPath: String): Boolean {
        return try {
            val fileList = context.assets.list(srcPath)
            if (fileList.isNullOrEmpty()) {
                return false
            }

            File(destPath).mkdirs()
            for (file in fileList) {
                val srcFile = "$srcPath/$file"
                val destFile = "$destPath/$file"
                val subFiles = context.assets.list(srcFile)
                if (subFiles != null && subFiles.isNotEmpty()) {
                    copyAssetFolder(context, srcFile, destFile)
                } else {
                    context.assets.open(srcFile).use { input ->
                        FileOutputStream(destFile).use { output ->
                            input.copyTo(output)
                        }
                    }
                }
            }
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    fun isModelAvailable(context: Context, language: String): Boolean {
        return getModelPath(context, language) != null
    }

    fun listAvailableModels(context: Context): List<String> {
        return languageModelMapping.keys.filter { isModelAvailable(context, it) }
    }

    fun downloadAndUnzipModel(context: Context, language: String, onProgress: (Int) -> Unit) {
        val urlStr = languageUrlMapping[language] ?: throw Exception("URL not found for language $language")
        val externalFilesDir = context.getExternalFilesDir(null) ?: throw Exception("External files dir not found")
        val destFolder = File(externalFilesDir, "models/stt/$language")
        
        if (!destFolder.exists()) {
            destFolder.mkdirs()
        }

        val tempZipFile = File(context.cacheDir, "model_$language.zip")

        // 1. Download to temporary zip file and report progress
        val url = URL(urlStr)
        val connection = url.openConnection() as HttpURLConnection
        connection.connect()

        val fileLength = connection.contentLength
        val input = BufferedInputStream(connection.inputStream)
        val output = FileOutputStream(tempZipFile)

        val buffer = ByteArray(8192)
        var totalRead = 0L
        var count: Int
        var lastProgress = -1

        while (input.read(buffer).also { count = it } != -1) {
            if (isDownloadCancelled) {
                output.close()
                input.close()
                connection.disconnect()
                tempZipFile.delete()
                throw Exception("Download cancelled by user")
            }

            output.write(buffer, 0, count)
            totalRead += count
            if (fileLength > 0) {
                val progress = ((totalRead * 100) / fileLength).toInt()
                // Throttle progress updates to avoid flooding React Native bridge
                if (progress > lastProgress) {
                    // Cap at 95% for download, last 5% for unzip
                    onProgress((progress * 0.95).toInt())
                    lastProgress = progress
                }
            }
        }
        output.flush()
        output.close()
        input.close()
        connection.disconnect()

        // 2. Unzip the file
        val zipInputStream = java.util.zip.ZipInputStream(tempZipFile.inputStream())
        var zipEntry = zipInputStream.nextEntry

        while (zipEntry != null) {
            val newFile = File(destFolder, zipEntry.name)
            if (zipEntry.isDirectory) {
                newFile.mkdirs()
            } else {
                newFile.parentFile?.mkdirs()
                val fos = FileOutputStream(newFile)
                val unzipBuffer = ByteArray(8192)
                var unzipCount: Int
                while (zipInputStream.read(unzipBuffer).also { unzipCount = it } != -1) {
                    fos.write(unzipBuffer, 0, unzipCount)
                }
                fos.close()
            }
            zipInputStream.closeEntry()
            zipEntry = zipInputStream.nextEntry
        }
        zipInputStream.close()

        // 3. Clean up
        tempZipFile.delete()
        onProgress(100)
    }
}
