/**
 * @fileoverview Weather module using the Open-Meteo API.
 *
 * Fetches current weather and daily forecast for a configured location.
 * Uses Open-Meteo (https://open-meteo.com/) which is free and requires no API key.
 * Location (latitude/longitude) is stored in the settings table.
 */

import { getDb } from './db.js';

/** Weather condition codes mapped to human-readable descriptions. */
const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

/** Stored location configuration. */
export interface WeatherLocation {
  latitude: number;
  longitude: number;
  name: string;
}

/** Current weather conditions. */
export interface CurrentWeather {
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  condition: string;
  conditionCode: number;
}

/** Daily forecast for a single day. */
export interface DailyForecast {
  date: string;
  temperatureMax: number;
  temperatureMin: number;
  condition: string;
  conditionCode: number;
  precipitationProbability: number;
  precipitationSum: number;
  windSpeedMax: number;
  sunrise: string;
  sunset: string;
}

/** Full weather response. */
export interface WeatherData {
  location: WeatherLocation;
  current: CurrentWeather;
  daily: DailyForecast[];
  fetchedAt: string;
}

/**
 * Gets the configured weather location from the database.
 * Returns null if no location is configured.
 */
export function getWeatherLocation(): WeatherLocation | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('weather_location') as { value: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as WeatherLocation;
  } catch {
    return null;
  }
}

/**
 * Saves the weather location to the database.
 */
export function setWeatherLocation(location: WeatherLocation): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run('weather_location', JSON.stringify(location));
}

/** Matches a US zip code (5 digits, optionally followed by -4 digits). */
const US_ZIP_RE = /^\d{5}(-\d{4})?$/;

/**
 * Looks up coordinates for a US zip code using the Zippopotam.us API.
 * Returns more precise coordinates than city-level geocoding.
 *
 * @param zip - US zip code (e.g. "10001" or "10001-1234").
 * @returns The location for the zip code, or null if not found.
 */
export async function geocodeZipCode(zip: string): Promise<WeatherLocation | null> {
  const fiveDigit = zip.substring(0, 5);
  const res = await fetch(`https://api.zippopotam.us/us/${fiveDigit}`);
  if (!res.ok) return null;

  const data = await res.json() as {
    'post code': string;
    places: Array<{
      'place name': string;
      longitude: string;
      latitude: string;
      state: string;
      'state abbreviation': string;
    }>;
  };

  if (!data.places || data.places.length === 0) return null;

  const place = data.places[0];
  const displayName = `${place['place name']}, ${place['state abbreviation']} ${fiveDigit}`;
  return {
    latitude: parseFloat(place.latitude),
    longitude: parseFloat(place.longitude),
    name: displayName,
  };
}

/**
 * Looks up coordinates for a location query. Supports US zip codes (via
 * Zippopotam.us for precise coordinates) and city/place names (via Open-Meteo).
 *
 * @param query - City name, place name, or US zip code.
 * @returns The best matching location, or null if not found.
 */
export async function geocodeLocation(query: string): Promise<WeatherLocation | null> {
  const trimmed = query.trim();

  // Try zip code lookup first for precise coordinates
  if (US_ZIP_RE.test(trimmed)) {
    const zipResult = await geocodeZipCode(trimmed);
    if (zipResult) return zipResult;
    // Fall through to Open-Meteo if zip lookup fails
  }

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(trimmed)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json() as {
    results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string; country?: string }>;
  };

  if (!data.results || data.results.length === 0) return null;

  const r = data.results[0];
  const displayName = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
  return { latitude: r.latitude, longitude: r.longitude, name: displayName };
}

/**
 * Fetches weather data from Open-Meteo for the given location.
 *
 * @param location - The latitude/longitude/name to fetch weather for.
 * @returns Weather data including current conditions and 7-day forecast.
 */
export async function fetchWeather(location: WeatherLocation): Promise<WeatherData> {
  const params = new URLSearchParams({
    latitude: location.latitude.toString(),
    longitude: location.longitude.toString(),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    forecast_days: '7',
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Open-Meteo API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as {
    current: {
      temperature_2m: number;
      relative_humidity_2m: number;
      apparent_temperature: number;
      weather_code: number;
      wind_speed_10m: number;
    };
    daily: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_sum: number[];
      precipitation_probability_max: number[];
      wind_speed_10m_max: number[];
      sunrise: string[];
      sunset: string[];
    };
  };

  const current: CurrentWeather = {
    temperature: data.current.temperature_2m,
    feelsLike: data.current.apparent_temperature,
    humidity: data.current.relative_humidity_2m,
    windSpeed: data.current.wind_speed_10m,
    condition: WMO_CODES[data.current.weather_code] || 'Unknown',
    conditionCode: data.current.weather_code,
  };

  const daily: DailyForecast[] = data.daily.time.map((date, i) => ({
    date,
    temperatureMax: data.daily.temperature_2m_max[i],
    temperatureMin: data.daily.temperature_2m_min[i],
    condition: WMO_CODES[data.daily.weather_code[i]] || 'Unknown',
    conditionCode: data.daily.weather_code[i],
    precipitationProbability: data.daily.precipitation_probability_max[i],
    precipitationSum: data.daily.precipitation_sum[i],
    windSpeedMax: data.daily.wind_speed_10m_max[i],
    sunrise: data.daily.sunrise[i],
    sunset: data.daily.sunset[i],
  }));

  return {
    location,
    current,
    daily,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetches weather for the configured location.
 * Returns null if no location is configured.
 */
export async function fetchConfiguredWeather(): Promise<WeatherData | null> {
  const location = getWeatherLocation();
  if (!location) return null;
  return fetchWeather(location);
}

/**
 * Formats weather data as plain text for inclusion in the briefing prompt.
 */
export function formatWeatherForPrompt(weather: WeatherData): string {
  const { location, current, daily } = weather;
  const lines: string[] = [
    `Current weather in ${location.name}:`,
    `  ${current.condition}, ${current.temperature}°F (feels like ${current.feelsLike}°F)`,
    `  Humidity: ${current.humidity}%, Wind: ${current.windSpeed} mph`,
    '',
    '7-day forecast:',
  ];

  for (const day of daily) {
    const date = new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const precip = day.precipitationProbability > 0
      ? ` | ${day.precipitationProbability}% precip`
      : '';
    lines.push(`  ${date}: ${day.condition}, ${day.temperatureMin}–${day.temperatureMax}°F${precip}`);
  }

  return lines.join('\n');
}
