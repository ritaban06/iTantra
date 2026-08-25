import React from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// Screens
import HomeScreen from '../screens/HomeScreen';
import ChatScreen from '../screens/ChatScreen';
import ConnectScreen from '../screens/ConnectScreen';
import LanguageScreen from '../screens/LanguageScreen';
import AlertScreen from '../screens/AlertScreen';
import SettingsScreen from '../screens/SettingsScreen';
import BenchmarkScreen from '../screens/BenchmarkScreen';

const Stack = createNativeStackNavigator();

// Custom Dark Theme for Emergency Context
const ITantraTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: '#0a0a0c', // Deep dark
    primary: '#00e676', // Vibrant neon green
    card: '#1c1c1e', // Slightly lighter for headers
    text: '#ffffff',
    border: '#2c2c2e',
    notification: '#ff3b30', // Alert red
  },
};

export default function AppNavigator() {
  return (
    <NavigationContainer theme={ITantraTheme}>
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerStyle: { backgroundColor: '#1c1c1e' },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: 'bold' },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen 
          name="Home" 
          component={HomeScreen} 
          options={{ title: 'iTantra' }}
        />
        <Stack.Screen 
          name="Chat" 
          component={ChatScreen} 
          options={{ title: 'Messages' }}
        />
        <Stack.Screen 
          name="Connect" 
          component={ConnectScreen} 
          options={{ title: 'Device Discovery' }}
        />
        <Stack.Screen 
          name="Language" 
          component={LanguageScreen} 
          options={{ title: 'Select Language' }}
        />
        <Stack.Screen 
          name="Alert" 
          component={AlertScreen} 
          options={{ title: 'Emergency Alert', presentation: 'modal' }}
        />
        <Stack.Screen 
          name="Settings" 
          component={SettingsScreen} 
          options={{ title: 'Settings' }}
        />
        <Stack.Screen 
          name="Benchmark" 
          component={BenchmarkScreen} 
          options={{ title: 'Performance Dashboard' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
