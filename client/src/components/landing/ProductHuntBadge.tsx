export const ProductHuntBadge = () => {
  return (
    <div className="flex justify-center mb-8">
      <a
        href="https://www.producthunt.com"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-6 py-3 bg-white dark:bg-gray-800 rounded-full border-2 border-orange-500 hover:border-orange-600 transition-colors duration-200 shadow-lg hover:shadow-xl"
      >
        <span className="text-2xl">🏆</span>
        <div className="flex flex-col text-left">
          <span className="text-xs text-gray-600 dark:text-gray-400 font-medium">
            Product Hunt
          </span>
          <span className="text-sm font-bold text-orange-500">
            #1 Product of the Day
          </span>
        </div>
      </a>
    </div>
  );
};
