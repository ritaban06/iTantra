package com.itantra.stt

import android.content.Context
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

enum class EngineType { VOSK, INDIC_CONFORMER }

data class LanguageConfig(
    val code: String,
    val engine: EngineType,
    val modelPath: String, 
    val vocabPath: String?
)

object ModelManager {
    @Volatile
    var isDownloadCancelled = false

    val languages = mapOf(
        "en" to LanguageConfig(
            code = "en",
            engine = EngineType.VOSK,
            modelPath = "models/stt/en/vosk-model-small-en-us",
            vocabPath = null
        ),
        "bn" to LanguageConfig(
            code = "bn",
            engine = EngineType.INDIC_CONFORMER,
            modelPath = "models/indicconformer/bn/model.onnx",
            vocabPath = "models/indicconformer/bn/vocab.json"
        ),
        "hi" to LanguageConfig(
            code = "hi",
            engine = EngineType.INDIC_CONFORMER,
            modelPath = "models/indicconformer/hi/model.onnx",
            vocabPath = "models/indicconformer/hi/vocab.json"
        )
    )

    fun getConfig(language: String): LanguageConfig? {
        return languages[language]
    }

    fun isModelAvailable(context: Context, language: String): Boolean {
        val config = getConfig(language) ?: return false
        val externalFilesDir = context.getExternalFilesDir(null)
        val destFile = File(externalFilesDir, config.modelPath)
        
        return destFile.exists() || language == "en"
    }

    fun getIndicConformerAbsolutePaths(context: Context, language: String): Pair<String?, String?> {
        val config = getConfig(language) ?: return Pair(null, null)
        val externalFilesDir = context.getExternalFilesDir(null)
        
        val modelFile = File(externalFilesDir, config.modelPath)
        val vocabFile = config.vocabPath?.let { File(externalFilesDir, it) }

        return if (modelFile.exists()) {
            Pair(modelFile.absolutePath, vocabFile?.absolutePath)
        } else {
            Pair(null, null)
        }
    }

    suspend fun downloadModel(context: Context, language: String, onProgress: (Int) -> Unit) {
        val config = getConfig(language) ?: throw Exception("Language config not found")
        
        if (config.engine == EngineType.VOSK) {
            withContext(Dispatchers.Main) { onProgress(100) }
            return
        }

        val modelUrl = "https://huggingface.co/sulabhkatiyar/indicconformer-120m-onnx/resolve/main/$language/model.onnx"
        val vocabUrl = "https://huggingface.co/sulabhkatiyar/indicconformer-120m-onnx/resolve/main/$language/vocab.json"

        val externalFilesDir = context.getExternalFilesDir(null)
        val modelFile = File(externalFilesDir, config.modelPath)
        val vocabFile = config.vocabPath?.let { File(externalFilesDir, it) }

        modelFile.parentFile?.mkdirs()

        if (vocabFile != null && !vocabFile.exists()) {
            downloadFile(vocabUrl, vocabFile)
        }

        if (!modelFile.exists()) {
            downloadFile(modelUrl, modelFile) { progress ->
                onProgress(progress)
            }
        } else {
            withContext(Dispatchers.Main) { onProgress(100) }
        }
    }

    private suspend fun downloadFile(urlString: String, destFile: File, onProgress: ((Int) -> Unit)? = null) {
        withContext(Dispatchers.IO) {
            val url = URL(urlString)
            val connection = url.openConnection() as HttpURLConnection
            connection.connect()

            val fileLength = connection.contentLength
            val input = BufferedInputStream(connection.inputStream)
            val output = FileOutputStream(destFile)

            val buffer = ByteArray(1024 * 64)
            var totalRead = 0L
            var count: Int
            var lastProgress = -1

            while (input.read(buffer).also { count = it } != -1) {
                if (isDownloadCancelled) {
                    output.close()
                    input.close()
                    connection.disconnect()
                    destFile.delete()
                    throw Exception("Download cancelled by user")
                }

                output.write(buffer, 0, count)
                totalRead += count
                if (fileLength > 0 && onProgress != null) {
                    val progress = ((totalRead * 100) / fileLength).toInt()
                    if (progress > lastProgress) {
                        withContext(Dispatchers.Main) {
                            onProgress(progress)
                        }
                        lastProgress = progress
                    }
                }
            }
            output.flush()
            output.close()
            input.close()
            connection.disconnect()
        }
    }

    fun getVoskModelPath(context: Context, assetPath: String): String? {
        val externalFilesDir = context.getExternalFilesDir(null)
        val destFolder = File(externalFilesDir, assetPath)

        if (destFolder.exists() && destFolder.isDirectory) {
            return destFolder.absolutePath
        }

        try {
            val assets = context.assets.list(assetPath)
            if (!assets.isNullOrEmpty()) {
                if (!destFolder.exists()) destFolder.mkdirs()
                if (copyAssetFolder(context, assetPath, destFolder.absolutePath)) {
                    return destFolder.absolutePath
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
            if (fileList.isNullOrEmpty()) return false

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
}
