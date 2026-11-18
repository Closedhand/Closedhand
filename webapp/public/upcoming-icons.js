// The line drawings for kinds of thing coming up (a flight, a train, a table),
// one set for the dashboard's Upcoming tab and the day ahead on the web chat's
// home, so a thing has the same picture in both. Each is the path of a
// 24-unit drawing; the page that shows it gives the line its weight.
(function () {
  window.UpcomingIcons = {
    flight: 'M2 16l20-6-2-3-7 2-6-6-2 1 4 7-5 1-2-2-2 1z',
    train: 'M7 3h10a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2zM5 10h14M9 21l1.5-4M15 21l-1.5-4',
    hotel: 'M3 19V6M3 14h18v5M21 14a3 3 0 0 0-3-3h-7v3M7 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    event: 'M4 6h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4zM14 6v12',
    restaurant: 'M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 3c-2 0-3 3-3 6s1 4 3 4v8',
    car: 'M4 16l1.5-5a2 2 0 0 1 2-1.5h9a2 2 0 0 1 2 1.5L20 16v3h-3M4 16v3h3M4 16h16M7.5 13.5h.01M16.5 13.5h.01',
    ferry: 'M3 18c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0M5 15l1-5h12l1 5M12 4v6',
    bus: 'M6 3h12a2 2 0 0 1 2 2v12H4V5a2 2 0 0 1 2-2zM4 11h16M7 20v-3M17 20v-3M7.5 14h.01M16.5 14h.01',
    appointment: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4',
    other: 'M9 4h6v3H9zM7 5.5H5.5V21h13V5.5H17M9 12h6M9 16h4',
  };
})();
