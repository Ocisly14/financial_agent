import { useState, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Upload, Star, Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface LandingPageHeroProps {
  onSearch: (query: string, files?: File[], options?: { shareCode?: string }) => void;
  onVoiceStart?: () => void;
  onFavoriteTaskChain?: () => void;
  containerStyle?: CSSProperties;
}

export const LandingPageHero: React.FC<LandingPageHeroProps> = ({
  onSearch,
  onVoiceStart,
  onFavoriteTaskChain,
  containerStyle,
}) => {
  const [query, setQuery] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim() || selectedFiles.length > 0) {
      onSearch(query, selectedFiles);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setSelectedFiles(files);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto" style={containerStyle}>
      <h1 className="text-4xl md:text-5xl font-bold text-center text-gray-900 dark:text-white mb-8">
        {t("landing.hero.title")}
      </h1>

      <form onSubmit={handleSubmit} className="w-full">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl border-2 border-gray-200 dark:border-gray-700 overflow-hidden transition-all duration-200 hover:border-gray-300 dark:hover:border-gray-600">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Dive into Crypto with Financial Agent"
            data-tour="landing-search"
            className="w-full px-6 py-5 text-lg bg-transparent border-none outline-none text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
          />

          <div className="flex items-center justify-between px-2 sm:px-4 py-3 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-1 sm:gap-2">
              {/* Attach File Button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                data-tour="landing-attach"
                className="inline-flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200"
                title="Attach File"
              >
                <Upload className="w-4 h-4" />
                <span className="hidden sm:inline">Attach</span>
                {selectedFiles.length > 0 && (
                  <span className="ml-1 px-2 py-0.5 text-xs bg-blue-500 text-white rounded-full">
                    {selectedFiles.length}
                  </span>
                )}
              </button>

              {/* Favorite Task Chain Button */}
              <button
                type="button"
                onClick={onFavoriteTaskChain}
                data-tour="landing-favorites"
                className="inline-flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200"
                title="Favorite Task Chain"
              >
                <Star className="w-4 h-4" />
                <span className="hidden sm:inline">Favorites</span>
              </button>

              {/* Voice Button */}
              <button
                type="button"
                onClick={onVoiceStart}
                data-tour="landing-voice"
                className="inline-flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200"
                title="Voice Input"
              >
                <Mic className="w-4 h-4" />
                <span className="hidden sm:inline">Voice</span>
              </button>
            </div>

            <button
              type="submit"
              disabled={!query.trim() && selectedFiles.length === 0}
              data-tour="landing-ask"
              className="px-4 sm:px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors duration-200"
            >
              Ask
            </button>
          </div>
        </div>
      </form>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.doc,.docx,.txt"
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* Selected files preview */}
      {selectedFiles.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {selectedFiles.map((file, index) => (
            <div
              key={index}
              className="px-3 py-1 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded-full text-sm flex items-center gap-2"
            >
              <span className="truncate max-w-xs">{file.name}</span>
              <button
                type="button"
                onClick={() => {
                  setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
                }}
                className="hover:text-blue-900 dark:hover:text-blue-100"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
