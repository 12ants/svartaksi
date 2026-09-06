import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthorApp } from './AuthorApp';
import './author.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthorApp />
  </StrictMode>,
);
