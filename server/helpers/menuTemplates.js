// Curated starter menus for the onboarding wizard ("Configurar Mi Menú").
// Spanish content, realistic MXN prices. Shape matches the AI-parse payload
// so bulkInsertMenu handles both paths identically:
//   { categories: [{name, sort_order}], items: [{name, category, price, description?, prep_time_minutes?}] }

const T = (id, name, description, icon, categories, items) => ({ id, name, description, icon, categories, items });
const i = (category, name, price, description, prep = 8) => ({ name, category, price, description, prep_time_minutes: prep });

const TEMPLATES = [
  T('taqueria', 'Taquería', 'Tacos, quesadillas y aguas frescas', 'taco',
    [
      { name: 'Tacos', sort_order: 1 },
      { name: 'Quesadillas y Más', sort_order: 2 },
      { name: 'Bebidas', sort_order: 3 },
    ],
    [
      i('Tacos', 'Taco de Pastor', 22, 'Con piña, cebolla y cilantro', 5),
      i('Tacos', 'Taco de Asada', 25, 'Res a la parrilla con cebolla y cilantro', 5),
      i('Tacos', 'Taco de Suadero', 24, 'Suave y jugoso, con salsa al gusto', 5),
      i('Tacos', 'Taco de Chorizo', 22, 'Chorizo rojo con papa', 5),
      i('Tacos', 'Taco Campechano', 26, 'Asada con chorizo', 5),
      i('Tacos', 'Orden de Pastor (5)', 95, '5 tacos de pastor con todo', 8),
      i('Quesadillas y Más', 'Quesadilla Sencilla', 30, 'Tortilla hecha a mano con quesillo', 7),
      i('Quesadillas y Más', 'Quesadilla con Carne', 45, 'Quesillo más la carne de tu elección', 8),
      i('Quesadillas y Más', 'Gringa', 48, 'Tortilla de harina, pastor y quesillo', 8),
      i('Quesadillas y Más', 'Volcán', 40, 'Tostada con queso gratinado y carne', 8),
      i('Bebidas', 'Agua de Horchata', 25, 'Vaso grande', 2),
      i('Bebidas', 'Agua de Jamaica', 25, 'Vaso grande', 2),
      i('Bebidas', 'Refresco', 25, 'Vidrio 355 ml', 1),
    ]),

  T('hamburguesas', 'Hamburguesas', 'Hamburguesas, papas y malteadas', 'burger',
    [
      { name: 'Hamburguesas', sort_order: 1 },
      { name: 'Complementos', sort_order: 2 },
      { name: 'Bebidas', sort_order: 3 },
    ],
    [
      i('Hamburguesas', 'Hamburguesa Clásica', 85, 'Carne de res, lechuga, jitomate, cebolla', 12),
      i('Hamburguesas', 'Hamburguesa con Queso', 95, 'Con queso americano derretido', 12),
      i('Hamburguesas', 'Hamburguesa con Tocino', 110, 'Tocino crujiente y queso', 14),
      i('Hamburguesas', 'Hamburguesa Doble', 130, 'Doble carne, doble queso', 15),
      i('Hamburguesas', 'Hamburguesa de Pollo', 90, 'Pechuga crujiente o a la plancha', 12),
      i('Complementos', 'Papas a la Francesa', 45, 'Orden grande', 8),
      i('Complementos', 'Papas con Queso y Tocino', 65, 'Gratinadas', 10),
      i('Complementos', 'Aros de Cebolla', 50, 'Orden de 8', 8),
      i('Bebidas', 'Malteada', 60, 'Chocolate, vainilla o fresa', 5),
      i('Bebidas', 'Refresco', 30, 'Vaso grande con hielo', 1),
      i('Bebidas', 'Limonada', 35, 'Natural o mineral', 3),
    ]),

  T('pizzeria', 'Pizzería', 'Pizzas artesanales y más', 'pizza',
    [
      { name: 'Pizzas', sort_order: 1 },
      { name: 'Entradas', sort_order: 2 },
      { name: 'Bebidas', sort_order: 3 },
    ],
    [
      i('Pizzas', 'Pizza Margarita', 145, 'Jitomate, mozzarella y albahaca', 18),
      i('Pizzas', 'Pizza Pepperoni', 165, 'Pepperoni y mozzarella', 18),
      i('Pizzas', 'Pizza Hawaiana', 165, 'Jamón y piña', 18),
      i('Pizzas', 'Pizza Mexicana', 180, 'Chorizo, jalapeño, cebolla y aguacate', 20),
      i('Pizzas', 'Pizza 4 Quesos', 185, 'Mozzarella, manchego, parmesano y azul', 18),
      i('Entradas', 'Pan de Ajo', 55, 'Con queso gratinado', 10),
      i('Entradas', 'Alitas (10 pzas)', 120, 'BBQ, buffalo o mango habanero', 15),
      i('Bebidas', 'Refresco', 30, 'Vidrio 355 ml', 1),
      i('Bebidas', 'Agua Fresca del Día', 28, 'Pregunta el sabor', 2),
      i('Bebidas', 'Cerveza Nacional', 45, 'Fría', 1),
    ]),

  T('cafeteria', 'Cafetería', 'Café de especialidad y repostería', 'coffee',
    [
      { name: 'Café Caliente', sort_order: 1 },
      { name: 'Bebidas Frías', sort_order: 2 },
      { name: 'Repostería', sort_order: 3 },
    ],
    [
      i('Café Caliente', 'Espresso', 35, 'Doble carga', 3),
      i('Café Caliente', 'Americano', 40, '12 oz', 3),
      i('Café Caliente', 'Cappuccino', 55, '12 oz con arte latte', 5),
      i('Café Caliente', 'Latte', 58, '12 oz, leche entera o vegetal', 5),
      i('Café Caliente', 'Mocha', 62, 'Con chocolate semiamargo', 5),
      i('Bebidas Frías', 'Cold Brew', 55, '16 oz, infusión 18 horas', 3),
      i('Bebidas Frías', 'Latte Helado', 60, '16 oz', 4),
      i('Bebidas Frías', 'Frappé', 68, 'Moka, caramelo o vainilla', 6),
      i('Repostería', 'Croissant', 45, 'Mantequilla, horneado en casa', 3),
      i('Repostería', 'Concha', 25, 'Vainilla o chocolate', 2),
      i('Repostería', 'Pan de Elote', 50, 'Rebanada', 2),
      i('Repostería', 'Galleta con Chispas', 35, 'Grande', 2),
    ]),

  T('sushi', 'Sushi', 'Rollos, nigiri y entradas japonesas', 'sushi',
    [
      { name: 'Rollos', sort_order: 1 },
      { name: 'Entradas', sort_order: 2 },
      { name: 'Bebidas', sort_order: 3 },
    ],
    [
      i('Rollos', 'Rollo California', 120, 'Surimi, aguacate y pepino', 12),
      i('Rollos', 'Rollo Philadelphia', 135, 'Salmón, queso crema y aguacate', 12),
      i('Rollos', 'Rollo Tempura', 145, 'Camarón empanizado, empapelado', 14),
      i('Rollos', 'Rollo Especial de la Casa', 165, 'Pregunta por la creación del chef', 15),
      i('Rollos', 'Rollo Vegetariano', 105, 'Aguacate, pepino, zanahoria', 10),
      i('Entradas', 'Edamames', 60, 'Con sal de mar o picantes', 6),
      i('Entradas', 'Gyozas (5 pzas)', 85, 'De cerdo o verdura, al vapor o doradas', 10),
      i('Entradas', 'Sopa Miso', 45, 'Con tofu y cebollín', 5),
      i('Bebidas', 'Té Verde', 35, 'Caliente o frío', 3),
      i('Bebidas', 'Refresco Japonés Ramune', 65, 'Sabores surtidos', 1),
    ]),

  T('cocina-mexicana', 'Cocina Mexicana', 'Desayunos, comidas y antojitos', 'restaurant',
    [
      { name: 'Desayunos', sort_order: 1 },
      { name: 'Platos Fuertes', sort_order: 2 },
      { name: 'Antojitos', sort_order: 3 },
      { name: 'Bebidas', sort_order: 4 },
    ],
    [
      i('Desayunos', 'Chilaquiles Verdes o Rojos', 85, 'Con pollo, huevo o solos; crema y queso', 12),
      i('Desayunos', 'Huevos al Gusto', 70, 'Con frijoles y tortillas hechas a mano', 10),
      i('Desayunos', 'Molletes', 65, 'Con pico de gallo', 10),
      i('Platos Fuertes', 'Enchiladas Suizas', 110, 'Tres enchiladas de pollo gratinadas', 15),
      i('Platos Fuertes', 'Milanesa de Res', 130, 'Con arroz, frijoles y ensalada', 18),
      i('Platos Fuertes', 'Mole con Pollo', 125, 'Receta de la casa, con arroz', 15),
      i('Antojitos', 'Sopes (3 pzas)', 70, 'Frijol, carne al gusto, crema y queso', 12),
      i('Antojitos', 'Pozole Rojo', 95, 'Plato grande con tostadas', 12),
      i('Bebidas', 'Agua Fresca del Día', 30, 'Vaso grande', 2),
      i('Bebidas', 'Café de Olla', 35, 'Con canela y piloncillo', 5),
      i('Bebidas', 'Refresco', 30, 'Vidrio 355 ml', 1),
    ]),
];

/** Listing shape the onboarding template picker consumes. */
export const TEMPLATE_LIST = TEMPLATES.map(t => ({
  id: t.id,
  name: t.name,
  description: t.description,
  icon: t.icon,
  item_count: t.items.length,
  category_count: t.categories.length,
}));

/** Full payload for one template (bulkInsertMenu shape), or null. */
export function getTemplate(id) {
  const t = TEMPLATES.find(x => x.id === id);
  if (!t) return null;
  return { categories: t.categories, items: t.items };
}
