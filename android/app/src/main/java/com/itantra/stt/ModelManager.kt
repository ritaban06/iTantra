package com.itantra.stt

import android.content.Context
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

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
            modelPath = "models/vosk/en",
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
        return language == "en" || language == "hi" || language == "bn"
    }

    fun listAvailableModels(context: Context): List<String> {
        return languages.keys.filter { isModelAvailable(context, it) }
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

    fun downloadAndUnzipModel(context: Context, language: String, onProgress: (Int) -> Unit) {
        onProgress(100)
    }
}
