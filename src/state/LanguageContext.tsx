import React, { createContext, useState, useContext } from 'react';

type LanguageMap = {
  [key: string]: string;
};

export const LANGUAGE_CODES: LanguageMap = {
  'English': 'en',
  'Hindi': 'hi',
  'Bengali': 'bn',
  'Gujarati': 'gu',
  'Marathi': 'mr',
  'Kannada': 'kn',
  'Malayalam': 'ml',
  'Tamil': 'ta',
  'Telugu': 'te',
  'Odia': 'or'
};

type LanguageContextType = {
  languageName: string;
  languageCode: string;
  setLanguage: (lang: string) => void;
};

const LanguageContext = createContext<LanguageContextType>({
  languageName: 'English',
  languageCode: 'en',
  setLanguage: () => {},
});

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
  const [languageName, setLanguageName] = useState('English');
  const languageCode = LANGUAGE_CODES[languageName] || 'en';

  return (
    <LanguageContext.Provider value={{ languageName, languageCode, setLanguage: setLanguageName }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
