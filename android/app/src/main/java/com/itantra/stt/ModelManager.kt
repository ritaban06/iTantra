package com.itantra.stt

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

enum class EngineType { VOSK, INDIC_CONFORMER /* deprecated — kept for type stability */ }

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
        )
        // "hi" / "bn" IndicConformer configs removed — Sherpa-ONNX replaces this path.
        // Sherpa STT handles Hindi/Bengali via its own bundled models.
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

    // getIndicConformerAbsolutePaths removed — IndicConformer path is deprecated.
    // Sherpa-ONNX STT handles Hindi/Bengali via its own bundled models.

    suspend fun downloadModel(context: Context, language: String, onProgress: (Int) -> Unit) {
        // All runtime-downloadable IndicConformer models removed.
        // Sherpa-ONNX bundles its models as assets.
        // Vosk models are copied from assets on first use.
        withContext(Dispatchers.Main) { onProgress(100) }
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
