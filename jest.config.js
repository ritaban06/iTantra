module.exports = {
  preset: '@react-native/jest-preset',
  // @react-navigation ships ESM ('lib/module'); transform it like RN itself.
  transformIgnorePatterns: [
    'node_modules/(?!(jest-)?react-native|@react-native(-community)?|@react-navigation/)',
  ],
};
