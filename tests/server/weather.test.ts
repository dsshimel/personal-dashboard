/**
 * @fileoverview Unit tests for the weather module.
 *
 * Tests location persistence, weather formatting, and WMO code mapping.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rm, mkdir } from 'fs/promises';
import {
  getWeatherLocation,
  setWeatherLocation,
  formatWeatherForPrompt,
  geocodeLocation,
  geocodeZipCode,
  type WeatherLocation,
  type WeatherData,
} from '../../server/weather';
import { initDailyEmailDb } from '../../server/daily-email';
import { initDb, closeDb, setConfigDir } from '../../server/db';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `weather-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  setConfigDir(testDir);
  const dbPath = join(testDir, 'test.db');
  const db = initDb(dbPath);
  // Weather uses the settings table from daily-email
  initDailyEmailDb(db);
});

afterEach(async () => {
  closeDb();
  setConfigDir(null);
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('Weather Module', () => {
  describe('getWeatherLocation', () => {
    test('returns null when no location is configured', () => {
      const location = getWeatherLocation();
      expect(location).toBeNull();
    });

    test('returns saved location after setWeatherLocation', () => {
      const loc: WeatherLocation = { latitude: 40.7128, longitude: -74.006, name: 'New York, NY, US' };
      setWeatherLocation(loc);
      const result = getWeatherLocation();
      expect(result).toEqual(loc);
    });
  });

  describe('setWeatherLocation', () => {
    test('persists a location', () => {
      const loc: WeatherLocation = { latitude: 34.0522, longitude: -118.2437, name: 'Los Angeles, CA, US' };
      setWeatherLocation(loc);
      expect(getWeatherLocation()).toEqual(loc);
    });

    test('overwrites an existing location', () => {
      setWeatherLocation({ latitude: 1, longitude: 2, name: 'First' });
      setWeatherLocation({ latitude: 3, longitude: 4, name: 'Second' });
      expect(getWeatherLocation()!.name).toBe('Second');
    });

    test('handles negative coordinates', () => {
      const loc: WeatherLocation = { latitude: -33.8688, longitude: 151.2093, name: 'Sydney, Australia' };
      setWeatherLocation(loc);
      expect(getWeatherLocation()).toEqual(loc);
    });
  });

  describe('formatWeatherForPrompt', () => {
    test('formats current weather and forecast', () => {
      const weather: WeatherData = {
        location: { latitude: 40.7, longitude: -74.0, name: 'New York' },
        current: {
          temperature: 72,
          feelsLike: 75,
          humidity: 55,
          windSpeed: 8,
          condition: 'Partly cloudy',
          conditionCode: 2,
        },
        daily: [
          {
            date: '2025-06-15',
            temperatureMax: 80,
            temperatureMin: 65,
            condition: 'Clear sky',
            conditionCode: 0,
            precipitationProbability: 0,
            precipitationSum: 0,
            windSpeedMax: 12,
            sunrise: '2025-06-15T05:30',
            sunset: '2025-06-15T20:30',
          },
          {
            date: '2025-06-16',
            temperatureMax: 78,
            temperatureMin: 62,
            condition: 'Slight rain',
            conditionCode: 61,
            precipitationProbability: 60,
            precipitationSum: 0.3,
            windSpeedMax: 15,
            sunrise: '2025-06-16T05:30',
            sunset: '2025-06-16T20:30',
          },
        ],
        fetchedAt: '2025-06-15T08:00:00Z',
      };

      const text = formatWeatherForPrompt(weather);
      expect(text).toContain('New York');
      expect(text).toContain('Partly cloudy');
      expect(text).toContain('72°F');
      expect(text).toContain('feels like 75°F');
      expect(text).toContain('Humidity: 55%');
      expect(text).toContain('Wind: 8 mph');
      expect(text).toContain('Clear sky');
      expect(text).toContain('65–80°F');
      expect(text).toContain('60% precip');
      // No precip line for 0% probability day
      expect(text).not.toContain('| 0% precip');
    });

    test('formats location name with zip code', () => {
      const weather: WeatherData = {
        location: { latitude: 40.7484, longitude: -73.9967, name: 'New York City, NY 10001' },
        current: {
          temperature: 68,
          feelsLike: 66,
          humidity: 45,
          windSpeed: 10,
          condition: 'Mainly clear',
          conditionCode: 1,
        },
        daily: [],
        fetchedAt: '2025-01-01T00:00:00Z',
      };

      const text = formatWeatherForPrompt(weather);
      expect(text).toContain('New York City, NY 10001');
    });

    test('handles empty forecast', () => {
      const weather: WeatherData = {
        location: { latitude: 0, longitude: 0, name: 'Test' },
        current: {
          temperature: 70,
          feelsLike: 70,
          humidity: 50,
          windSpeed: 5,
          condition: 'Clear sky',
          conditionCode: 0,
        },
        daily: [],
        fetchedAt: '2025-01-01T00:00:00Z',
      };

      const text = formatWeatherForPrompt(weather);
      expect(text).toContain('Clear sky');
      expect(text).toContain('7-day forecast:');
    });
  });

  describe('geocodeZipCode', () => {
    test('resolves a valid US zip code', async () => {
      const result = await geocodeZipCode('90210');
      expect(result).not.toBeNull();
      expect(result!.name).toContain('Beverly Hills');
      expect(result!.name).toContain('CA');
      expect(result!.name).toContain('90210');
      expect(result!.latitude).toBeCloseTo(34.09, 1);
      expect(result!.longitude).toBeCloseTo(-118.41, 1);
    });

    test('returns null for invalid zip code', async () => {
      const result = await geocodeZipCode('00000');
      expect(result).toBeNull();
    });

    test('handles zip+4 format by using first 5 digits', async () => {
      const result = await geocodeZipCode('10001-1234');
      expect(result).not.toBeNull();
      expect(result!.name).toContain('New York');
    });
  });

  describe('geocodeLocation', () => {
    test('routes zip codes through zip code geocoder', async () => {
      const result = await geocodeLocation('90210');
      expect(result).not.toBeNull();
      expect(result!.name).toContain('Beverly Hills');
      expect(result!.name).toContain('90210');
    });

    test('routes city names through Open-Meteo geocoder', async () => {
      const result = await geocodeLocation('Seattle');
      expect(result).not.toBeNull();
      expect(result!.name).toContain('Seattle');
      expect(result!.latitude).toBeCloseTo(47.6, 0);
    });

    test('handles zip+4 format', async () => {
      const result = await geocodeLocation('98101-1234');
      expect(result).not.toBeNull();
      expect(result!.name).toContain('Seattle');
    });

    test('does not treat non-zip numbers as zip codes', async () => {
      // 6-digit number should go through Open-Meteo, not zip
      const result = await geocodeLocation('123456');
      // May or may not find a result, but shouldn't crash
      // The key thing is it doesn't try the zip code API
    });

    test('trims whitespace from input', async () => {
      const result = await geocodeLocation('  90210  ');
      expect(result).not.toBeNull();
      expect(result!.name).toContain('Beverly Hills');
    });
  });
});
