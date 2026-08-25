package com.itantra.stt

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

object ModelManager {

    private val languageModelMapping = mapOf(
        "en" to "vosk-model-small-en-us",
        "hi" to "vosk-model-hi-0.22",
        "bn" to "vosk-model-bn-0.2"
    )

    fun getModelPath(context: Context, language: String): String? {
        val modelFolderName = languageModelMapping[language] ?: return null
        val externalFilesDir = context.getExternalFilesDir(null)
        val destFolder = File(externalFilesDir, "models/stt/$language")
        
        // For MVP, we assume models will be either extracted here from assets or downloaded here.
        // In this implementation, if the folder exists, we return its path.
        if (destFolder.exists() && destFolder.isDirectory) {
            return destFolder.absolutePath
        }
        
        return null
    }

    fun isModelAvailable(context: Context, language: String): Boolean {
        return getModelPath(context, language) != null
    }

    fun listAvailableModels(context: Context): List<String> {
        return languageModelMapping.keys.filter { isModelAvailable(context, it) }
    }
}
