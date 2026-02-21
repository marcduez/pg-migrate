COMMENT ON SCHEMA public IS 'this is a ''test''!';


CREATE DOMAIN public."bıgınt" AS bigint;


COMMENT ON DOMAIN public."bıgınt" IS 'Your comment here describing the bıgınt domain type.';


CREATE TYPE public.mpaa_rating AS ENUM (
  'G',
  'PG',
  'PG-13',
  'R',
  'NC-17'
);


COMMENT ON TYPE public.mpaa_rating IS 'Your comment here describing the enum type.';


CREATE DOMAIN public.year AS integer
  CONSTRAINT my_constraint CHECK ((VALUE >= 1950)),
  CONSTRAINT year_check CHECK (((VALUE >= 1901) AND (VALUE <= 2155)));


CREATE OR REPLACE FUNCTION public._group_concat(text, text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
SELECT CASE
  WHEN $2 IS NULL THEN $1
  WHEN $1 IS NULL THEN $2
  ELSE $1 || ', ' || $2
END
$function$;


COMMENT ON FUNCTION public._group_concat(text, text) IS 'Comment on _group_concat';


CREATE OR REPLACE FUNCTION public.film_in_stock(p_film_id integer, p_store_id integer, OUT p_film_count integer)
 RETURNS SETOF integer
 LANGUAGE sql
AS $function$
     SELECT inventory_id
     FROM inventory
     WHERE film_id = $1
     AND store_id = $2
     AND inventory_in_stock(inventory_id);
$function$;


CREATE OR REPLACE FUNCTION public.film_not_in_stock(p_film_id integer, p_store_id integer, OUT p_film_count integer)
 RETURNS SETOF integer
 LANGUAGE sql
AS $function$
    SELECT inventory_id
    FROM inventory
    WHERE film_id = $1
    AND store_id = $2
    AND NOT inventory_in_stock(inventory_id);
$function$;


CREATE OR REPLACE FUNCTION public.get_customer_balance(p_customer_id integer, p_effective_date timestamp with time zone)
 RETURNS numeric
 LANGUAGE plpgsql
AS $function$
       --#OK, WE NEED TO CALCULATE THE CURRENT BALANCE GIVEN A CUSTOMER_ID AND A DATE
       --#THAT WE WANT THE BALANCE TO BE EFFECTIVE FOR. THE BALANCE IS:
       --#   1) RENTAL FEES FOR ALL PREVIOUS RENTALS
       --#   2) ONE DOLLAR FOR EVERY DAY THE PREVIOUS RENTALS ARE OVERDUE
       --#   3) IF A FILM IS MORE THAN RENTAL_DURATION * 2 OVERDUE, CHARGE THE REPLACEMENT_COST
       --#   4) SUBTRACT ALL PAYMENTS MADE BEFORE THE DATE SPECIFIED
DECLARE
    v_rentfees DECIMAL(5,2); --#FEES PAID TO RENT THE VIDEOS INITIALLY
    v_overfees INTEGER;      --#LATE FEES FOR PRIOR RENTALS
    v_payments DECIMAL(5,2); --#SUM OF PAYMENTS MADE PREVIOUSLY
BEGIN
    SELECT COALESCE(SUM(film.rental_rate),0) INTO v_rentfees
    FROM film, inventory, rental
    WHERE film.film_id = inventory.film_id
      AND inventory.inventory_id = rental.inventory_id
      AND rental.rental_date <= p_effective_date
      AND rental.customer_id = p_customer_id;

    SELECT COALESCE(SUM(IF((rental.return_date - rental.rental_date) > (film.rental_duration * '1 day'::interval),
        ((rental.return_date - rental.rental_date) - (film.rental_duration * '1 day'::interval)),0)),0) INTO v_overfees
    FROM rental, inventory, film
    WHERE film.film_id = inventory.film_id
      AND inventory.inventory_id = rental.inventory_id
      AND rental.rental_date <= p_effective_date
      AND rental.customer_id = p_customer_id;

    SELECT COALESCE(SUM(payment.amount),0) INTO v_payments
    FROM payment
    WHERE payment.payment_date <= p_effective_date
    AND payment.customer_id = p_customer_id;

    RETURN v_rentfees + v_overfees - v_payments;
END
$function$;


CREATE OR REPLACE FUNCTION public.inventory_held_by_customer(p_inventory_id integer)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_customer_id INTEGER;
BEGIN

  SELECT customer_id INTO v_customer_id
  FROM rental
  WHERE return_date IS NULL
  AND inventory_id = p_inventory_id;

  RETURN v_customer_id;
END $function$;


CREATE OR REPLACE FUNCTION public.inventory_in_stock(p_inventory_id integer)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_rentals INTEGER;
    v_out     INTEGER;
BEGIN
    -- AN ITEM IS IN-STOCK IF THERE ARE EITHER NO ROWS IN THE rental TABLE
    -- FOR THE ITEM OR ALL ROWS HAVE return_date POPULATED

    SELECT count(*) INTO v_rentals
    FROM rental
    WHERE inventory_id = p_inventory_id;

    IF v_rentals = 0 THEN
      RETURN TRUE;
    END IF;

    SELECT COUNT(rental_id) INTO v_out
    FROM inventory LEFT JOIN rental USING(inventory_id)
    WHERE inventory.inventory_id = p_inventory_id
    AND rental.return_date IS NULL;

    IF v_out > 0 THEN
      RETURN FALSE;
    ELSE
      RETURN TRUE;
    END IF;
END $function$;


CREATE OR REPLACE FUNCTION public.last_day(timestamp with time zone)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE STRICT
AS $function$
  SELECT CASE
    WHEN EXTRACT(MONTH FROM $1) = 12 THEN
      (((EXTRACT(YEAR FROM $1) + 1) operator(pg_catalog.||) '-01-01')::date - INTERVAL '1 day')::date
    ELSE
      ((EXTRACT(YEAR FROM $1) operator(pg_catalog.||) '-' operator(pg_catalog.||) (EXTRACT(MONTH FROM $1) + 1) operator(pg_catalog.||) '-01')::date - INTERVAL '1 day')::date
    END
$function$;


CREATE OR REPLACE FUNCTION public.last_updated()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.last_update = CURRENT_TIMESTAMP;
    RETURN NEW;
END $function$;


CREATE OR REPLACE FUNCTION public.rewards_report(min_monthly_purchases integer, min_dollar_amount_purchased numeric)
 RETURNS SETOF customer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    last_month_start DATE;
    last_month_end DATE;
rr RECORD;
tmpSQL TEXT;
BEGIN

    /* Some sanity checks... */
    IF min_monthly_purchases = 0 THEN
        RAISE EXCEPTION 'Minimum monthly purchases parameter must be > 0';
    END IF;
    IF min_dollar_amount_purchased = 0.00 THEN
        RAISE EXCEPTION 'Minimum monthly dollar amount purchased parameter must be > $0.00';
    END IF;

    last_month_start := CURRENT_DATE - '3 month'::interval;
    last_month_start := to_date((extract(YEAR FROM last_month_start) || '-' || extract(MONTH FROM last_month_start) || '-01'),'YYYY-MM-DD');
    last_month_end := LAST_DAY(last_month_start);

    /*
    Create a temporary storage area for Customer IDs.
    */
    CREATE TEMPORARY TABLE tmpCustomer (customer_id INTEGER NOT NULL PRIMARY KEY);

    /*
    Find all customers meeting the monthly purchase requirements
    */

    tmpSQL := 'INSERT INTO tmpCustomer (customer_id)
        SELECT p.customer_id
        FROM payment AS p
        WHERE DATE(p.payment_date) BETWEEN '||quote_literal(last_month_start) ||' AND '|| quote_literal(last_month_end) || '
        GROUP BY customer_id
        HAVING SUM(p.amount) > '|| min_dollar_amount_purchased || '
        AND COUNT(customer_id) > ' ||min_monthly_purchases ;

    EXECUTE tmpSQL;

    /*
    Output ALL customer information of matching rewardees.
    Customize output as needed.
    */
    FOR rr IN EXECUTE 'SELECT c.* FROM tmpCustomer AS t INNER JOIN customer AS c ON t.customer_id = c.customer_id' LOOP
        RETURN NEXT rr;
    END LOOP;

    /* Clean up */
    tmpSQL := 'DROP TABLE tmpCustomer';
    EXECUTE tmpSQL;

RETURN;
END
$function$;


CREATE AGGREGATE public.group_concat(text) (
   SFUNC = public._group_concat,
   STYPE = text
);


CREATE SEQUENCE public.actor_actor_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.address_address_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.category_category_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.city_city_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.country_country_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.customer_customer_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.film_film_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.inventory_inventory_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.language_language_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.payment_payment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.rental_rental_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.staff_staff_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE SEQUENCE public.store_store_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


CREATE TABLE "public"."actor" (
    "actor_id" integer DEFAULT nextval('actor_actor_id_seq'::regclass) NOT NULL,
    "first_name" text NOT NULL,
    "last_name" text NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE "public"."address" (
    "address" text NOT NULL,
    "address2" text,
    "address_id" integer DEFAULT nextval('address_address_id_seq'::regclass) NOT NULL,
    "city_id" integer NOT NULL,
    "district" text NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL,
    "phone" text NOT NULL,
    "postal_code" text
);



CREATE TABLE "public"."category" (
    "category_id" integer DEFAULT nextval('category_category_id_seq'::regclass) NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL,
    "name" text NOT NULL
);



CREATE TABLE "public"."city" (
    "city" text NOT NULL,
    "city_id" integer DEFAULT nextval('city_city_id_seq'::regclass) NOT NULL,
    "country_id" integer NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE "public"."country" (
    "country" text NOT NULL,
    "country_id" integer DEFAULT nextval('country_country_id_seq'::regclass) NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE "public"."customer" (
    "active" integer,
    "activebool" boolean DEFAULT true NOT NULL,
    "address_id" integer NOT NULL,
    "create_date" date DEFAULT CURRENT_DATE NOT NULL,
    "customer_id" integer DEFAULT nextval('customer_customer_id_seq'::regclass) NOT NULL,
    "email" text,
    "first_name" text NOT NULL,
    "last_name" text NOT NULL,
    "last_update" timestamp with time zone DEFAULT now(),
    "store_id" integer NOT NULL
);



CREATE TABLE "public"."film_actor" (
    "actor_id" integer NOT NULL,
    "film_id" integer NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE "public"."film_category" (
    "category_id" integer NOT NULL,
    "film_id" integer NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE "public"."film" (
    "description" text,
    "film_id" integer DEFAULT nextval('film_film_id_seq'::regclass) NOT NULL,
    "fulltext" tsvector NOT NULL,
    "language_id" integer NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL,
    "length" smallint,
    "original_language_id" integer,
    "rating" mpaa_rating DEFAULT 'G'::mpaa_rating,
    "release_year" year,
    "rental_duration" smallint DEFAULT 3 NOT NULL,
    "rental_rate" numeric(4,2) DEFAULT 4.99 NOT NULL,
    "replacement_cost" numeric(5,2) DEFAULT 19.99 NOT NULL,
    "special_features" text[],
    "title" text NOT NULL
);



CREATE TABLE "public"."inventory" (
    "film_id" integer NOT NULL,
    "inventory_id" integer DEFAULT nextval('inventory_inventory_id_seq'::regclass) NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL,
    "store_id" integer NOT NULL
);



CREATE TABLE "public"."language" (
    "language_id" integer DEFAULT nextval('language_language_id_seq'::regclass) NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL,
    "name" character(20) NOT NULL
);



CREATE TABLE "public"."payment_p2022_01" (
    "amount" numeric(5,2) NOT NULL,
    "customer_id" integer NOT NULL,
    "payment_date" timestamp with time zone NOT NULL,
    "payment_id" integer DEFAULT nextval('payment_payment_id_seq'::regclass) NOT NULL,
    "rental_id" integer NOT NULL,
    "staff_id" integer NOT NULL
);



CREATE TABLE "public"."payment_p2022_02" (
    "amount" numeric(5,2) NOT NULL,
    "customer_id" integer NOT NULL,
    "payment_date" timestamp with time zone NOT NULL,
    "payment_id" integer DEFAULT nextval('payment_payment_id_seq'::regclass) NOT NULL,
    "rental_id" integer NOT NULL,
    "staff_id" integer NOT NULL
);



CREATE TABLE "public"."payment_p2022_03" (
    "amount" numeric(5,2) NOT NULL,
    "customer_id" integer NOT NULL,
    "payment_date" timestamp with time zone NOT NULL,
    "payment_id" integer DEFAULT nextval('payment_payment_id_seq'::regclass) NOT NULL,
    "rental_id" integer NOT NULL,
    "staff_id" integer NOT NULL
);



CREATE TABLE "public"."payment_p2022_04" (
    "amount" numeric(5,2) NOT NULL,
    "customer_id" integer NOT NULL,
    "payment_date" timestamp with time zone NOT NULL,
    "payment_id" integer DEFAULT nextval('payment_payment_id_seq'::regclass) NOT NULL,
    "rental_id" integer NOT NULL,
    "staff_id" integer NOT NULL
);



CREATE TABLE "public"."payment_p2022_05" (
    "amount" numeric(5,2) NOT NULL,
    "customer_id" integer NOT NULL,
    "payment_date" timestamp with time zone NOT NULL,
    "payment_id" integer DEFAULT nextval('payment_payment_id_seq'::regclass) NOT NULL,
    "rental_id" integer NOT NULL,
    "staff_id" integer NOT NULL
);



CREATE TABLE "public"."payment_p2022_06" (
    "amount" numeric(5,2) NOT NULL,
    "customer_id" integer NOT NULL,
    "payment_date" timestamp with time zone NOT NULL,
    "payment_id" integer DEFAULT nextval('payment_payment_id_seq'::regclass) NOT NULL,
    "rental_id" integer NOT NULL,
    "staff_id" integer NOT NULL
);



CREATE TABLE "public"."payment_p2022_07" (
    "amount" numeric(5,2) NOT NULL,
    "customer_id" integer NOT NULL,
    "payment_date" timestamp with time zone NOT NULL,
    "payment_id" integer DEFAULT nextval('payment_payment_id_seq'::regclass) NOT NULL,
    "rental_id" integer NOT NULL,
    "staff_id" integer NOT NULL
);



CREATE TABLE "public"."rental" (
    "customer_id" integer NOT NULL,
    "inventory_id" integer NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL,
    "rental_date" timestamp with time zone NOT NULL,
    "rental_id" integer DEFAULT nextval('rental_rental_id_seq'::regclass) NOT NULL,
    "return_date" timestamp with time zone,
    "staff_id" integer NOT NULL
);



CREATE TABLE "public"."staff" (
    "active" boolean DEFAULT true NOT NULL,
    "address_id" integer NOT NULL,
    "email" text,
    "first_name" text NOT NULL,
    "last_name" text NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL,
    "password" text,
    "picture" bytea,
    "staff_id" integer DEFAULT nextval('staff_staff_id_seq'::regclass) NOT NULL,
    "store_id" integer NOT NULL,
    "username" text NOT NULL
);



CREATE TABLE "public"."store" (
    "address_id" integer NOT NULL,
    "last_update" timestamp with time zone DEFAULT now() NOT NULL,
    "manager_staff_id" integer NOT NULL,
    "store_id" integer DEFAULT nextval('store_store_id_seq'::regclass) NOT NULL
);



ALTER TABLE ONLY public.actor
    ADD CONSTRAINT actor_pkey PRIMARY KEY (actor_id);


ALTER TABLE ONLY public.address
    ADD CONSTRAINT address_city_id_fkey FOREIGN KEY (city_id) REFERENCES city(city_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.address
    ADD CONSTRAINT address_pkey PRIMARY KEY (address_id);


ALTER TABLE ONLY public.category
    ADD CONSTRAINT category_pkey PRIMARY KEY (category_id);


ALTER TABLE ONLY public.city
    ADD CONSTRAINT city_country_id_fkey FOREIGN KEY (country_id) REFERENCES country(country_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.city
    ADD CONSTRAINT city_pkey PRIMARY KEY (city_id);


ALTER TABLE ONLY public.country
    ADD CONSTRAINT country_pkey PRIMARY KEY (country_id);


ALTER TABLE ONLY public.customer
    ADD CONSTRAINT customer_address_id_fkey FOREIGN KEY (address_id) REFERENCES address(address_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.customer
    ADD CONSTRAINT customer_pkey PRIMARY KEY (customer_id);


ALTER TABLE ONLY public.customer
    ADD CONSTRAINT customer_store_id_fkey FOREIGN KEY (store_id) REFERENCES store(store_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.film
    ADD CONSTRAINT film_language_id_fkey FOREIGN KEY (language_id) REFERENCES language(language_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.film
    ADD CONSTRAINT film_original_language_id_fkey FOREIGN KEY (original_language_id) REFERENCES language(language_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.film
    ADD CONSTRAINT film_pkey PRIMARY KEY (film_id);


ALTER TABLE ONLY public.film_actor
    ADD CONSTRAINT film_actor_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES actor(actor_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.film_actor
    ADD CONSTRAINT film_actor_film_id_fkey FOREIGN KEY (film_id) REFERENCES film(film_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.film_actor
    ADD CONSTRAINT film_actor_pkey PRIMARY KEY (actor_id, film_id);


ALTER TABLE ONLY public.film_category
    ADD CONSTRAINT film_category_category_id_fkey FOREIGN KEY (category_id) REFERENCES category(category_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.film_category
    ADD CONSTRAINT film_category_film_id_fkey FOREIGN KEY (film_id) REFERENCES film(film_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.film_category
    ADD CONSTRAINT film_category_pkey PRIMARY KEY (film_id, category_id);


ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_film_id_fkey FOREIGN KEY (film_id) REFERENCES film(film_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_pkey PRIMARY KEY (inventory_id);


ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_store_id_fkey FOREIGN KEY (store_id) REFERENCES store(store_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.language
    ADD CONSTRAINT language_pkey PRIMARY KEY (language_id);


ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_pkey PRIMARY KEY (payment_date, payment_id);


ALTER TABLE ONLY public.payment_p2022_01
    ADD CONSTRAINT payment_p2022_01_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customer(customer_id);


ALTER TABLE ONLY public.payment_p2022_01
    ADD CONSTRAINT payment_p2022_01_pkey PRIMARY KEY (payment_date, payment_id);


ALTER TABLE ONLY public.payment_p2022_01
    ADD CONSTRAINT payment_p2022_01_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES rental(rental_id);


ALTER TABLE ONLY public.payment_p2022_01
    ADD CONSTRAINT payment_p2022_01_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(staff_id);


ALTER TABLE ONLY public.payment_p2022_02
    ADD CONSTRAINT payment_p2022_02_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customer(customer_id);


ALTER TABLE ONLY public.payment_p2022_02
    ADD CONSTRAINT payment_p2022_02_pkey PRIMARY KEY (payment_date, payment_id);


ALTER TABLE ONLY public.payment_p2022_02
    ADD CONSTRAINT payment_p2022_02_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES rental(rental_id);


ALTER TABLE ONLY public.payment_p2022_02
    ADD CONSTRAINT payment_p2022_02_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(staff_id);


ALTER TABLE ONLY public.payment_p2022_03
    ADD CONSTRAINT payment_p2022_03_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customer(customer_id);


ALTER TABLE ONLY public.payment_p2022_03
    ADD CONSTRAINT payment_p2022_03_pkey PRIMARY KEY (payment_date, payment_id);


ALTER TABLE ONLY public.payment_p2022_03
    ADD CONSTRAINT payment_p2022_03_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES rental(rental_id);


ALTER TABLE ONLY public.payment_p2022_03
    ADD CONSTRAINT payment_p2022_03_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(staff_id);


ALTER TABLE ONLY public.payment_p2022_04
    ADD CONSTRAINT payment_p2022_04_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customer(customer_id);


ALTER TABLE ONLY public.payment_p2022_04
    ADD CONSTRAINT payment_p2022_04_pkey PRIMARY KEY (payment_date, payment_id);


ALTER TABLE ONLY public.payment_p2022_04
    ADD CONSTRAINT payment_p2022_04_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES rental(rental_id);


ALTER TABLE ONLY public.payment_p2022_04
    ADD CONSTRAINT payment_p2022_04_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(staff_id);


ALTER TABLE ONLY public.payment_p2022_05
    ADD CONSTRAINT payment_p2022_05_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customer(customer_id);


ALTER TABLE ONLY public.payment_p2022_05
    ADD CONSTRAINT payment_p2022_05_pkey PRIMARY KEY (payment_date, payment_id);


ALTER TABLE ONLY public.payment_p2022_05
    ADD CONSTRAINT payment_p2022_05_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES rental(rental_id);


ALTER TABLE ONLY public.payment_p2022_05
    ADD CONSTRAINT payment_p2022_05_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(staff_id);


ALTER TABLE ONLY public.payment_p2022_06
    ADD CONSTRAINT payment_p2022_06_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customer(customer_id);


ALTER TABLE ONLY public.payment_p2022_06
    ADD CONSTRAINT payment_p2022_06_pkey PRIMARY KEY (payment_date, payment_id);


ALTER TABLE ONLY public.payment_p2022_06
    ADD CONSTRAINT payment_p2022_06_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES rental(rental_id);


ALTER TABLE ONLY public.payment_p2022_06
    ADD CONSTRAINT payment_p2022_06_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(staff_id);


ALTER TABLE ONLY public.payment_p2022_07
    ADD CONSTRAINT payment_p2022_07_pkey PRIMARY KEY (payment_date, payment_id);


ALTER TABLE ONLY public.rental
    ADD CONSTRAINT rental_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customer(customer_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.rental
    ADD CONSTRAINT rental_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES inventory(inventory_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.rental
    ADD CONSTRAINT rental_pkey PRIMARY KEY (rental_id);


ALTER TABLE ONLY public.rental
    ADD CONSTRAINT rental_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_address_id_fkey FOREIGN KEY (address_id) REFERENCES address(address_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_pkey PRIMARY KEY (staff_id);


ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_store_id_fkey FOREIGN KEY (store_id) REFERENCES store(store_id);


ALTER TABLE ONLY public.store
    ADD CONSTRAINT store_address_id_fkey FOREIGN KEY (address_id) REFERENCES address(address_id) ON UPDATE CASCADE ON DELETE RESTRICT;


ALTER TABLE ONLY public.store
    ADD CONSTRAINT store_pkey PRIMARY KEY (store_id);


CREATE VIEW public.actor_info AS
 SELECT a.actor_id,
    a.first_name,
    a.last_name,
    group_concat(DISTINCT ((c.name || ': '::text) || ( SELECT group_concat(f.title) AS group_concat
           FROM ((film f
             JOIN film_category fc_1 ON ((f.film_id = fc_1.film_id)))
             JOIN film_actor fa_1 ON ((f.film_id = fa_1.film_id)))
          WHERE ((fc_1.category_id = c.category_id) AND (fa_1.actor_id = a.actor_id))
          GROUP BY fa_1.actor_id))) AS film_info
   FROM (((actor a
     LEFT JOIN film_actor fa ON ((a.actor_id = fa.actor_id)))
     LEFT JOIN film_category fc ON ((fa.film_id = fc.film_id)))
     LEFT JOIN category c ON ((fc.category_id = c.category_id)))
  GROUP BY a.actor_id, a.first_name, a.last_name;


COMMENT ON VIEW public.actor_info IS 'Comment on view actor_info';


CREATE VIEW public.customer_list AS
 SELECT cu.customer_id AS id,
    ((cu.first_name || ' '::text) || cu.last_name) AS name,
    a.address,
    a.postal_code AS "zip code",
    a.phone,
    city.city,
    country.country,
        CASE
            WHEN cu.activebool THEN 'active'::text
            ELSE ''::text
        END AS notes,
    cu.store_id AS sid
   FROM (((customer cu
     JOIN address a ON ((cu.address_id = a.address_id)))
     JOIN city ON ((a.city_id = city.city_id)))
     JOIN country ON ((city.country_id = country.country_id)));


CREATE VIEW public.film_list AS
 SELECT film.film_id AS fid,
    film.title,
    film.description,
    category.name AS category,
    film.rental_rate AS price,
    film.length,
    film.rating,
    group_concat(((actor.first_name || ' '::text) || actor.last_name)) AS actors
   FROM ((((category
     LEFT JOIN film_category ON ((category.category_id = film_category.category_id)))
     LEFT JOIN film ON ((film_category.film_id = film.film_id)))
     JOIN film_actor ON ((film.film_id = film_actor.film_id)))
     JOIN actor ON ((film_actor.actor_id = actor.actor_id)))
  GROUP BY film.film_id, film.title, film.description, category.name, film.rental_rate, film.length, film.rating;


CREATE VIEW public.nicer_but_slower_film_list AS
 SELECT film.film_id AS fid,
    film.title,
    film.description,
    category.name AS category,
    film.rental_rate AS price,
    film.length,
    film.rating,
    group_concat((((upper("substring"(actor.first_name, 1, 1)) || lower("substring"(actor.first_name, 2))) || upper("substring"(actor.last_name, 1, 1))) || lower("substring"(actor.last_name, 2)))) AS actors
   FROM ((((category
     LEFT JOIN film_category ON ((category.category_id = film_category.category_id)))
     LEFT JOIN film ON ((film_category.film_id = film.film_id)))
     JOIN film_actor ON ((film.film_id = film_actor.film_id)))
     JOIN actor ON ((film_actor.actor_id = actor.actor_id)))
  GROUP BY film.film_id, film.title, film.description, category.name, film.rental_rate, film.length, film.rating;


CREATE VIEW public.sales_by_film_category AS
 SELECT c.name AS category,
    sum(p.amount) AS total_sales
   FROM (((((payment p
     JOIN rental r ON ((p.rental_id = r.rental_id)))
     JOIN inventory i ON ((r.inventory_id = i.inventory_id)))
     JOIN film f ON ((i.film_id = f.film_id)))
     JOIN film_category fc ON ((f.film_id = fc.film_id)))
     JOIN category c ON ((fc.category_id = c.category_id)))
  GROUP BY c.name
  ORDER BY (sum(p.amount)) DESC;


CREATE VIEW public.sales_by_store AS
 SELECT ((c.city || ','::text) || cy.country) AS store,
    ((m.first_name || ' '::text) || m.last_name) AS manager,
    sum(p.amount) AS total_sales
   FROM (((((((payment p
     JOIN rental r ON ((p.rental_id = r.rental_id)))
     JOIN inventory i ON ((r.inventory_id = i.inventory_id)))
     JOIN store s ON ((i.store_id = s.store_id)))
     JOIN address a ON ((s.address_id = a.address_id)))
     JOIN city c ON ((a.city_id = c.city_id)))
     JOIN country cy ON ((c.country_id = cy.country_id)))
     JOIN staff m ON ((s.manager_staff_id = m.staff_id)))
  GROUP BY cy.country, c.city, s.store_id, m.first_name, m.last_name
  ORDER BY cy.country, c.city;


CREATE VIEW public.staff_list AS
 SELECT s.staff_id AS id,
    ((s.first_name || ' '::text) || s.last_name) AS name,
    a.address,
    a.postal_code AS "zip code",
    a.phone,
    city.city,
    country.country,
    s.store_id AS sid
   FROM (((staff s
     JOIN address a ON ((s.address_id = a.address_id)))
     JOIN city ON ((a.city_id = city.city_id)))
     JOIN country ON ((city.country_id = country.country_id)));


ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_01 FOR VALUES FROM ('2021-12-31 19:00:00-05') TO ('2022-01-31 19:00:00-05');


ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_02 FOR VALUES FROM ('2022-01-31 19:00:00-05') TO ('2022-02-28 19:00:00-05');


ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_03 FOR VALUES FROM ('2022-02-28 19:00:00-05') TO ('2022-03-31 20:00:00-04');


ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_04 FOR VALUES FROM ('2022-03-31 20:00:00-04') TO ('2022-04-30 20:00:00-04');


ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_05 FOR VALUES FROM ('2022-04-30 20:00:00-04') TO ('2022-05-31 20:00:00-04');


ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_06 FOR VALUES FROM ('2022-05-31 20:00:00-04') TO ('2022-06-30 20:00:00-04');


ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_07 FOR VALUES FROM ('2022-06-30 20:00:00-04') TO ('2022-07-31 20:00:00-04');


CREATE INDEX film_fulltext_idx ON public.film USING gist (fulltext);


CREATE INDEX idx_actor_last_name ON public.actor USING btree (last_name);


CREATE INDEX idx_fk_address_id ON public.customer USING btree (address_id);


CREATE INDEX idx_fk_city_id ON public.address USING btree (city_id);


CREATE INDEX idx_fk_country_id ON public.city USING btree (country_id);


CREATE INDEX idx_fk_film_id ON public.film_actor USING btree (film_id);


CREATE INDEX idx_fk_inventory_id ON public.rental USING btree (inventory_id);


CREATE INDEX idx_fk_language_id ON public.film USING btree (language_id);


CREATE INDEX idx_fk_original_language_id ON public.film USING btree (original_language_id);


CREATE INDEX idx_fk_payment_p2022_01_customer_id ON public.payment_p2022_01 USING btree (customer_id);


CREATE INDEX idx_fk_payment_p2022_01_staff_id ON public.payment_p2022_01 USING btree (staff_id);


CREATE INDEX idx_fk_payment_p2022_02_customer_id ON public.payment_p2022_02 USING btree (customer_id);


CREATE INDEX idx_fk_payment_p2022_02_staff_id ON public.payment_p2022_02 USING btree (staff_id);


CREATE INDEX idx_fk_payment_p2022_03_customer_id ON public.payment_p2022_03 USING btree (customer_id);


CREATE INDEX idx_fk_payment_p2022_03_staff_id ON public.payment_p2022_03 USING btree (staff_id);


CREATE INDEX idx_fk_payment_p2022_04_customer_id ON public.payment_p2022_04 USING btree (customer_id);


CREATE INDEX idx_fk_payment_p2022_04_staff_id ON public.payment_p2022_04 USING btree (staff_id);


CREATE INDEX idx_fk_payment_p2022_05_customer_id ON public.payment_p2022_05 USING btree (customer_id);


CREATE INDEX idx_fk_payment_p2022_05_staff_id ON public.payment_p2022_05 USING btree (staff_id);


CREATE INDEX idx_fk_payment_p2022_06_customer_id ON public.payment_p2022_06 USING btree (customer_id);


CREATE INDEX idx_fk_payment_p2022_06_staff_id ON public.payment_p2022_06 USING btree (staff_id);


CREATE INDEX idx_fk_store_id ON public.customer USING btree (store_id);


CREATE INDEX idx_last_name ON public.customer USING btree (last_name);


CREATE INDEX idx_store_id_film_id ON public.inventory USING btree (store_id, film_id);


CREATE INDEX idx_title ON public.film USING btree (title);


CREATE UNIQUE INDEX idx_unq_manager_staff_id ON public.store USING btree (manager_staff_id);


CREATE UNIQUE INDEX idx_unq_rental_rental_date_inventory_id_customer_id ON public.rental USING btree (rental_date, inventory_id, customer_id);


CREATE INDEX payment_p2022_01_customer_id_idx ON public.payment_p2022_01 USING btree (customer_id);


CREATE INDEX payment_p2022_02_customer_id_idx ON public.payment_p2022_02 USING btree (customer_id);


CREATE INDEX payment_p2022_03_customer_id_idx ON public.payment_p2022_03 USING btree (customer_id);


CREATE INDEX payment_p2022_04_customer_id_idx ON public.payment_p2022_04 USING btree (customer_id);


CREATE INDEX payment_p2022_05_customer_id_idx ON public.payment_p2022_05 USING btree (customer_id);


CREATE INDEX payment_p2022_06_customer_id_idx ON public.payment_p2022_06 USING btree (customer_id);


CREATE UNIQUE INDEX rental_category ON public.rental_by_category USING btree (category);


ALTER INDEX public.idx_fk_payment_p2022_01_customer_id ATTACH PARTITION public.payment_p2022_01;


ALTER INDEX public.idx_fk_payment_p2022_01_staff_id ATTACH PARTITION public.payment_p2022_01;


ALTER INDEX public.idx_fk_payment_p2022_02_customer_id ATTACH PARTITION public.payment_p2022_02;


ALTER INDEX public.idx_fk_payment_p2022_02_staff_id ATTACH PARTITION public.payment_p2022_02;


ALTER INDEX public.idx_fk_payment_p2022_03_customer_id ATTACH PARTITION public.payment_p2022_03;


ALTER INDEX public.idx_fk_payment_p2022_03_staff_id ATTACH PARTITION public.payment_p2022_03;


ALTER INDEX public.idx_fk_payment_p2022_04_customer_id ATTACH PARTITION public.payment_p2022_04;


ALTER INDEX public.idx_fk_payment_p2022_04_staff_id ATTACH PARTITION public.payment_p2022_04;


ALTER INDEX public.idx_fk_payment_p2022_05_customer_id ATTACH PARTITION public.payment_p2022_05;


ALTER INDEX public.idx_fk_payment_p2022_05_staff_id ATTACH PARTITION public.payment_p2022_05;


ALTER INDEX public.idx_fk_payment_p2022_06_customer_id ATTACH PARTITION public.payment_p2022_06;


ALTER INDEX public.idx_fk_payment_p2022_06_staff_id ATTACH PARTITION public.payment_p2022_06;


ALTER INDEX public.payment_p2022_01_customer_id_idx ATTACH PARTITION public.payment_p2022_01;


ALTER INDEX public.payment_p2022_01_pkey ATTACH PARTITION public.payment_p2022_01;


ALTER INDEX public.payment_p2022_02_customer_id_idx ATTACH PARTITION public.payment_p2022_02;


ALTER INDEX public.payment_p2022_02_pkey ATTACH PARTITION public.payment_p2022_02;


ALTER INDEX public.payment_p2022_03_customer_id_idx ATTACH PARTITION public.payment_p2022_03;


ALTER INDEX public.payment_p2022_03_pkey ATTACH PARTITION public.payment_p2022_03;


ALTER INDEX public.payment_p2022_04_customer_id_idx ATTACH PARTITION public.payment_p2022_04;


ALTER INDEX public.payment_p2022_04_pkey ATTACH PARTITION public.payment_p2022_04;


ALTER INDEX public.payment_p2022_05_customer_id_idx ATTACH PARTITION public.payment_p2022_05;


ALTER INDEX public.payment_p2022_05_pkey ATTACH PARTITION public.payment_p2022_05;


ALTER INDEX public.payment_p2022_06_customer_id_idx ATTACH PARTITION public.payment_p2022_06;


ALTER INDEX public.payment_p2022_06_pkey ATTACH PARTITION public.payment_p2022_06;


ALTER INDEX public.payment_p2022_07_pkey ATTACH PARTITION public.payment_p2022_07;