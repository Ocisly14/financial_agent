import * as React from "react";

type TocState = {
    availability: Record<string, boolean>;
    activeId: string | null;
    isMobileOpen: boolean;
};

type TocAction =
    | { type: "register"; id: string }
    | { type: "unregister"; id: string }
    | { type: "setAvailability"; id: string; available: boolean }
    | { type: "setActive"; id: string | null }
    | { type: "open" }
    | { type: "close" }
    | { type: "toggle" };

const getFirstAvailable = (availability: Record<string, boolean>): string | null => {
    for (const [id, isAvailable] of Object.entries(availability)) {
        if (isAvailable) {
            return id;
        }
    }
    return null;
};

const tableOfContentsReducer = (state: TocState, action: TocAction): TocState => {
    switch (action.type) {
        case "register": {
            if (state.availability[action.id] !== undefined) {
                return state;
            }

            return {
                ...state,
                availability: {
                    ...state.availability,
                    [action.id]: false,
                },
            };
        }
        case "unregister": {
            if (!(action.id in state.availability)) {
                return state;
            }

            const { [action.id]: _removed, ...rest } = state.availability;
            const nextActiveId = state.activeId === action.id ? getFirstAvailable(rest) : state.activeId;
            const nextIsMobileOpen = state.activeId === action.id ? false : state.isMobileOpen && nextActiveId !== null;

            return {
                availability: rest,
                activeId: nextActiveId,
                isMobileOpen: nextIsMobileOpen,
            };
        }
        case "setAvailability": {
            const nextAvailability = {
                ...state.availability,
                [action.id]: action.available,
            };

            let nextActiveId = state.activeId;
            let nextIsMobileOpen = state.isMobileOpen;

            if (action.available) {
                nextActiveId = action.id;
            } else if (state.activeId === action.id) {
                nextActiveId = getFirstAvailable(nextAvailability);
                nextIsMobileOpen = false;
            }

            if (nextActiveId && !nextAvailability[nextActiveId]) {
                nextActiveId = getFirstAvailable(nextAvailability);
            }

            if (!nextActiveId) {
                nextIsMobileOpen = false;
            }

            return {
                availability: nextAvailability,
                activeId: nextActiveId,
                isMobileOpen: nextIsMobileOpen,
            };
        }
        case "setActive": {
            if (action.id === null) {
                return {
                    availability: state.availability,
                    activeId: null,
                    isMobileOpen: false,
                };
            }

            if (!state.availability[action.id]) {
                return state;
            }

            return {
                ...state,
                activeId: action.id,
            };
        }
        case "open": {
            const activeId = state.activeId ?? getFirstAvailable(state.availability);
            if (!activeId) {
                return {
                    availability: state.availability,
                    activeId: null,
                    isMobileOpen: false,
                };
            }

            return {
                availability: state.availability,
                activeId,
                isMobileOpen: true,
            };
        }
        case "close": {
            if (!state.isMobileOpen) {
                return state;
            }

            return {
                ...state,
                isMobileOpen: false,
            };
        }
        case "toggle": {
            if (state.isMobileOpen) {
                return {
                    ...state,
                    isMobileOpen: false,
                };
            }

            const activeId = state.activeId ?? getFirstAvailable(state.availability);
            if (!activeId) {
                return {
                    availability: state.availability,
                    activeId: null,
                    isMobileOpen: false,
                };
            }

            return {
                availability: state.availability,
                activeId,
                isMobileOpen: true,
            };
        }
        default:
            return state;
    }
};

type TableOfContentsContextValue = {
    isMobileOpen: boolean;
    hasAvailable: boolean;
    activeId: string | null;
    registerToc: (id: string) => () => void;
    setTocAvailability: (id: string, available: boolean) => void;
    setActiveToc: (id: string | null) => void;
    openMobile: () => void;
    closeMobile: () => void;
    toggleMobile: () => void;
};

const TableOfContentsContext = React.createContext<TableOfContentsContextValue | null>(null);

const initialState: TocState = {
    availability: {},
    activeId: null,
    isMobileOpen: false,
};

export const TableOfContentsProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
    const [state, dispatch] = React.useReducer(tableOfContentsReducer, initialState);

    const registerToc = React.useCallback((id: string) => {
        dispatch({ type: "register", id });

        return () => {
            dispatch({ type: "unregister", id });
        };
    }, []);

    const setTocAvailability = React.useCallback((id: string, available: boolean) => {
        dispatch({ type: "setAvailability", id, available });
    }, []);

    const setActiveToc = React.useCallback((id: string | null) => {
        dispatch({ type: "setActive", id });
    }, []);

    const openMobile = React.useCallback(() => {
        dispatch({ type: "open" });
    }, []);

    const closeMobile = React.useCallback(() => {
        dispatch({ type: "close" });
    }, []);

    const toggleMobile = React.useCallback(() => {
        dispatch({ type: "toggle" });
    }, []);

    const hasAvailable = React.useMemo(() => {
        return Object.values(state.availability).some(Boolean);
    }, [state.availability]);

    const value = React.useMemo<TableOfContentsContextValue>(() => ({
        isMobileOpen: state.isMobileOpen,
        hasAvailable,
        activeId: state.activeId,
        registerToc,
        setTocAvailability,
        setActiveToc,
        openMobile,
        closeMobile,
        toggleMobile,
    }), [
        state.isMobileOpen,
        hasAvailable,
        state.activeId,
        registerToc,
        setTocAvailability,
        setActiveToc,
        openMobile,
        closeMobile,
        toggleMobile,
    ]);

    return (
        <TableOfContentsContext.Provider value={value}>
            {children}
        </TableOfContentsContext.Provider>
    );
};

export const useTableOfContents = (): TableOfContentsContextValue => {
    const context = React.useContext(TableOfContentsContext);
    if (!context) {
        throw new Error("useTableOfContents must be used within a TableOfContentsProvider.");
    }

    return context;
};
