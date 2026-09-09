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
  partnerLanguageName: string;
  partnerLanguageCode: string;
  setLanguage: (lang: string) => void;
  setPartnerLanguage: (lang: string) => void;
};

const LanguageContext = createContext<LanguageContextType>({
  languageName: 'English',
  languageCode: 'en',
  partnerLanguageName: 'Hindi',
  partnerLanguageCode: 'hi',
  setLanguage: () => {},
  setPartnerLanguage: () => {},
});

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
  const [languageName, setLanguageName] = useState('English');
  const [partnerLanguageName, setPartnerLanguageName] = useState('Hindi');
  const languageCode = LANGUAGE_CODES[languageName] || 'en';
  const partnerLanguageCode = LANGUAGE_CODES[partnerLanguageName] || 'hi';

  return (
    <LanguageContext.Provider value={{ 
      languageName, 
      languageCode, 
      partnerLanguageName,
      partnerLanguageCode,
      setLanguage: setLanguageName,
      setPartnerLanguage: setPartnerLanguageName
    }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);

